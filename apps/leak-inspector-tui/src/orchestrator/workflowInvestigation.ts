/**
 * Staged multi-agent investigation (replaces the single free-form loop).
 *
 *   Stage A  static evidence — bounded fan-out of context-isolated LLM sub-agents,
 *            each driving the read-only static tools over its candidate partition;
 *            tool outputs are folded deterministically into per-bundle staticContext.
 *   Stage B  dynamic evidence — ONE worker (build once + sanitizers) running
 *            concurrently with Stage A; attaches runtime evidence to bundles.
 *   Stage C  synthesize — the per-bundle staticContext + evidence are now populated.
 *   Stage D  hybrid judge — heuristic verdict for every bundle (now well-fed), then
 *            an LLM second opinion for the BORDERLINE ones, bounded.
 *
 * Each sub-agent is a fresh `queryLoop` with a small context + restricted tools, so
 * concurrency is bounded (no single 364k-token context) and the heuristic judge is
 * never blind again. Implements the `InvestigationPhase` interface → drop-in.
 */

import {
  buildCallModel,
  loadMcpTools,
  mapWithLimit,
  productionDeps,
  queryLoop,
  type AgentEvent,
  type CallModel,
  type Message,
  type Tool,
  type ToolCtx,
} from '@mcpvul/agent-core';
import { AgentActionKind, DynamicMode, type AgentDecision } from '@mcpvul/common/types';
import type { RunConfig } from '../config';
import type { AgentMeta, InvestigationContext, InvestigationOutcome, InvestigationPhase } from './investigation';
import { mcpToolFlags, CONTENT_CAPABLE_TOOLS } from '../domain/mcpToolPlan';
import { buildDomainTools } from '../domain/domainTools';
import { heuristicVerdict } from '../domain/judge';
import { StepLog } from '../domain/stepLog';
import { ScanEventName } from './events';
import { makeAgentEventHandler } from './toAgentEvents';
import { withHostContent, withHostPathMapping, toProviderSettings } from './toolWrappers';
import { type StaticContextStore, withStaticContextCapture } from '../domain/staticContext';
import {
  DONE_STATIC,
  DONE_DYNAMIC,
  buildDoneTool,
  staticSubAgentSystemPrompt,
  staticSubAgentUserMessage,
  dynamicWorkerSystemPrompt,
  dynamicWorkerUserMessage,
} from '../domain/subAgentPrompts';
import { judgeBundleWithLlm, isBorderline } from '../domain/llmJudge';

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

export function buildWorkflowInvestigationPhase(cfg: RunConfig, dynamicMode: DynamicMode): InvestigationPhase {
  return {
    async run(candidates, ctx: InvestigationContext): Promise<InvestigationOutcome> {
      const stepLog = new StepLog();
      const MAIN: AgentMeta = { id: 'main', label: 'main', kind: 'main' };
      const onNotice = (text: string) => {
        const ev: AgentEvent = { type: 'notice', text };
        ctx.onAgentEvent?.(ev, MAIN);
        stepLog.record(ev);
      };
      const callModel: CallModel = buildCallModel(toProviderSettings(cfg), () => globalThis.crypto.randomUUID(), onNotice);
      const bridge = makeAgentEventHandler(ctx.emitter);
      const toolCtx: ToolCtx = { cwd: ctx.repoPath, requestPermission: ctx.requestPermission, abortSignal: ctx.abortSignal };

      const allBundles = candidates.getAllBundles();
      const staticStore: StaticContextStore = new Map();
      const decisions: AgentDecision[] = [];
      const usage = { inputTokens: 0, outputTokens: 0 };
      const transcripts: Message[] = [];
      let totalTurns = 0;

      // Load static + dynamic tool catalogs in parallel.
      const wantDynamic = dynamicMode !== DynamicMode.OFF && !!ctx.dynamicClient;
      const [staticRaw, dynamicRaw] = await Promise.all([
        loadMcpTools(ctx.staticClient, mcpToolFlags),
        wantDynamic ? loadMcpTools(ctx.dynamicClient!, mcpToolFlags) : Promise.resolve([] as Tool[]),
      ]);
      const contentStatic = staticRaw.filter((t) => CONTENT_CAPABLE_TOOLS.has(t.name));

      const domainTools = buildDomainTools({
        candidates,
        repoPath: ctx.repoPath,
        pathResolver: ctx.pathResolver,
      });
      const readFileTool = domainTools.find((t) => t.name === 'read_file')!;
      const recordEvidenceTool = domainTools.find((t) => t.name === 'record_evidence')!;

      ctx.emitter.emit(ScanEventName.INVESTIGATION_STARTED, {
        candidates: allBundles.length,
        tools: contentStatic.length + dynamicRaw.length,
        maxTurns: cfg.maxTurns,
      });

      // Spawn one sub-agent loop and drain its events into the shared sinks, tagged
      // with `agent` so the TUI can keep a separate log per sub-agent.
      const runSubAgent = async (
        agent: AgentMeta,
        params: {
          systemPrompt: string;
          messages: Message[];
          tools: Tool[];
          maxTurns: number;
          terminalTools: Set<string>;
          checkCompletion?: () => string | null;
        },
      ): Promise<void> => {
        const gen = queryLoop({
          systemPrompt: params.systemPrompt,
          messages: params.messages,
          tools: params.tools,
          ctx: toolCtx,
          maxTurns: params.maxTurns,
          deps: productionDeps(callModel),
          terminalTools: params.terminalTools,
          compaction: cfg.compaction,
          onModelActivity: ctx.onModelActivity,
          checkCompletion: params.checkCompletion,
        });
        let res;
        while (true) {
          const next = await gen.next();
          if (next.done) {
            res = next.value;
            break;
          }
          const ev = next.value as AgentEvent;
          bridge.handle(ev);
          ctx.onAgentEvent?.(ev, agent);
          stepLog.record(ev);
        }
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;
        totalTurns += res.turns;
        transcripts.push(...res.messages);
      };

      // ── Stage A: static evidence (bounded fan-out) ──
      const groups = chunk(allBundles, cfg.workflow.staticGroupSize);
      onNotice(`Stage A · static evidence: ${groups.length} sub-agent(s), concurrency ${cfg.workflow.staticConcurrency}`);
      const staticFanout = mapWithLimit(groups, cfg.workflow.staticConcurrency, async (group, gi) => {
        if (ctx.abortSignal?.aborted) return;
        const tools: Tool[] = [
          ...contentStatic.map((t) => withHostContent(withStaticContextCapture(t, staticStore, group), ctx.repoPath)),
          readFileTool,
          buildDoneTool(DONE_STATIC, 'Finish static evidence gathering for this group of candidates.'),
        ];
        const agent: AgentMeta = { id: `static-${gi}`, label: `static ${gi + 1}/${groups.length}`, kind: 'static' };
        await runSubAgent(agent, {
          systemPrompt: staticSubAgentSystemPrompt(ctx.repoPath),
          messages: [{ role: 'user', content: staticSubAgentUserMessage(group) }],
          tools,
          maxTurns: cfg.maxTurns,
          terminalTools: new Set([DONE_STATIC]),
          checkCompletion: () => {
            const missing = group.filter((b) => !staticStore.has(b.bundleId));
            if (missing.length === 0) return null;
            const ids = missing.map((b) => b.bundleId).join(', ');
            return `You stopped, but ${missing.length} candidate(s) have NO static evidence yet: ${ids}. Run functionSummary/pathConstraints/astScan/ownershipConventions for them, then call ${DONE_STATIC}. Only tool calls advance the work.`;
          },
        });
      });

      // ── Stage B: dynamic evidence (single worker, concurrent with A) ──
      const dynamicWorker = (async () => {
        if (!wantDynamic) return;
        if (dynamicRaw.length === 0) {
          onNotice('dynamic enabled but no dynamic tools loaded — analyzer unreachable; running static-only');
          return;
        }
        onNotice('Stage B · dynamic evidence: 1 worker (build once + sanitizers)');
        const tools: Tool[] = [
          ...dynamicRaw.map((t) => withHostPathMapping(t, ctx.pathResolver)),
          readFileTool,
          recordEvidenceTool,
          buildDoneTool(DONE_DYNAMIC, 'Finish dynamic evidence collection.'),
        ];
        await runSubAgent({ id: 'dynamic', label: 'dynamic', kind: 'dynamic' }, {
          systemPrompt: dynamicWorkerSystemPrompt(ctx.repoPath, ctx.buildCommand),
          messages: [{ role: 'user', content: dynamicWorkerUserMessage(allBundles) }],
          tools,
          maxTurns: cfg.maxTurns + 10,
          terminalTools: new Set([DONE_DYNAMIC]),
        });
      })();

      await Promise.all([staticFanout, dynamicWorker]);

      // ── Stage C: synthesize (deterministic — context + evidence already merged) ──
      onNotice(`Stage C · synthesize: ${staticStore.size}/${allBundles.length} candidates have static context`);

      // ── Stage D: hybrid judge ──
      onNotice('Stage D · judge: heuristic for all, LLM for borderline');
      for (const b of allBundles) {
        if (b.verdict) continue;
        b.verdict = heuristicVerdict(b, staticStore.get(b.bundleId) ?? {});
      }
      const borderline = allBundles.filter((b) => b.verdict && isBorderline(b.verdict));
      onNotice(`Stage D · ${borderline.length}/${allBundles.length} borderline → LLM judge (concurrency ${cfg.workflow.judgeConcurrency})`);
      await mapWithLimit(borderline, cfg.workflow.judgeConcurrency, async (b) => {
        if (ctx.abortSignal?.aborted) return;
        const llm = await judgeBundleWithLlm(b, staticStore.get(b.bundleId), callModel, ctx.abortSignal, cfg.llm.judgeTemperature);
        if (!llm) return;
        b.verdict = llm;
        b.updatedAt = new Date().toISOString();
        decisions.push({
          turn: decisions.length + 1,
          actionKind: AgentActionKind.JUDGE_BUNDLE,
          rationale: (llm.explanation || '').slice(0, 200),
          strategySource: 'llm',
          toolName: 'llm_judge',
          targetBundleIds: [b.bundleId],
          reasoning: '',
          decidedAt: new Date().toISOString(),
          resultSummary: `${llm.verdict} (${(llm.confidence * 100).toFixed(0)}%)`,
        });
      });

      bridge.finishPendingPhases();
      ctx.emitter.emit(ScanEventName.INVESTIGATION_FINISHED, {
        turns: totalTurns,
        reason: 'finalized',
        verdicts: allBundles.filter((b) => b.verdict).length,
      });

      return {
        reason: 'finalized',
        turns: totalTurns,
        agentDecisions: decisions,
        transcript: transcripts as unknown[],
        usage,
        staticContext: Object.fromEntries(staticStore) as Record<string, Record<string, any>>,
        stepsLog: stepLog.toMarkdown(),
      };
    },
  };
}
