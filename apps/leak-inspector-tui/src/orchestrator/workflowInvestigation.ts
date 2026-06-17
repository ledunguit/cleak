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
import { AgentActionKind, DynamicMode, type AgentDecision, type LeakBundle } from '@mcpvul/common/types';
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
  createDynamicRunStore,
  withDynamicEvidenceCapture,
  reconcileDynamicEvidence,
  computeDynamicCoverage,
} from '../domain/dynamicEvidence';
import {
  DONE_STATIC,
  DONE_DYNAMIC,
  buildDoneTool,
  staticSubAgentSystemPrompt,
  staticSubAgentUserMessage,
  dynamicWorkerSystemPrompt,
  dynamicWorkerUserMessage,
} from '../domain/subAgentPrompts';
import { judgeBundleWithLlm, shouldEscalate } from '../domain/llmJudge';
import { judgeByConsensus, type ConsensusVerdict } from '@mcpvul/common/analysis/consensus-judge';

/**
 * Group candidates by FILE affinity (a file is never split across sub-agents), then
 * pack files into size-capped groups. Keeping same-file candidates together lets one
 * static sub-agent observe interprocedural patterns (allocator + freeing sink in the
 * same file) that arbitrary size-only chunking splits apart. Deterministic — files
 * are sorted, so grouping never adds run-to-run variance.
 */
export function groupByFileAffinity(bundles: LeakBundle[], size: number): LeakBundle[][] {
  const cap = Math.max(1, size);
  const byFile = new Map<string, LeakBundle[]>();
  for (const b of bundles) {
    const f = b.candidate.file_path || '';
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f)!.push(b);
  }
  const groups: LeakBundle[][] = [];
  let cur: LeakBundle[] = [];
  for (const file of [...byFile.keys()].sort()) {
    const fb = byFile.get(file)!;
    if (cur.length > 0 && cur.length + fb.length > cap) {
      groups.push(cur);
      cur = [];
    }
    cur.push(...fb); // a single file larger than `cap` stays whole (its own over-size group)
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
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
      const dynStore = createDynamicRunStore();
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
      const groups = groupByFileAffinity(allBundles, cfg.workflow.staticGroupSize);
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
        // The sanitizer tools are wrapped so their findings are captured into
        // `dynStore` DETERMINISTICALLY — the LLM only drives build/run; it can no
        // longer add or omit evidence that changes a verdict. `record_evidence` is
        // intentionally NOT in this toolset (the wrapper is the sole source).
        const tools: Tool[] = [
          ...dynamicRaw.map((t) => withDynamicEvidenceCapture(withHostPathMapping(t, ctx.pathResolver), dynStore)),
          readFileTool,
          buildDoneTool(DONE_DYNAMIC, 'Finish dynamic evidence collection.'),
        ];
        await runSubAgent({ id: 'dynamic', label: 'dynamic', kind: 'dynamic' }, {
          systemPrompt: dynamicWorkerSystemPrompt(ctx.repoPath, ctx.buildCommand),
          messages: [{ role: 'user', content: dynamicWorkerUserMessage(allBundles) }],
          tools,
          maxTurns: cfg.maxTurns + 10,
          terminalTools: new Set([DONE_DYNAMIC]),
          // Mirror the static worker's completion guard: don't let the worker quit
          // before a sanitizer has actually run (no run ⇒ no coverage for anyone).
          checkCompletion: () => {
            if (dynStore.runs.some((r) => r.success)) return null;
            return `No successful sanitizer run yet. buildTarget (with a sanitizer flag), then run lsanRun/asanRun/valgrindMemcheck, then call ${DONE_DYNAMIC}. Only tool calls advance the work.`;
          },
        });
      })();

      await Promise.all([staticFanout, dynamicWorker]);

      // ── Deterministic reconciliation: fold every captured dynamic finding into the
      // best-correlated bundle, then stamp each bundle's honest coverage status. This
      // replaces the LLM's discretionary record_evidence as the source of truth. ──
      reconcileDynamicEvidence(dynStore, allBundles, ctx.pathResolver);
      for (const b of allBundles) b.dynamicCoverage = computeDynamicCoverage(dynStore, b, wantDynamic);

      // ── Stage C: synthesize (deterministic — context + evidence already merged) ──
      onNotice(`Stage C · synthesize: ${staticStore.size}/${allBundles.length} candidates have static context`);

      // ── Stage D: hybrid judge ──
      onNotice('Stage D · judge: heuristic for all, LLM for borderline');
      for (const b of allBundles) {
        if (b.verdict) continue;
        b.verdict = heuristicVerdict(b, staticStore.get(b.bundleId) ?? {});
      }
      const borderline = allBundles.filter((b) => b.verdict && shouldEscalate(b));
      // n>1 ⇒ multi-agent consensus (self-consistency); n=1 ⇒ the single-LLM judge
      // (unchanged regression baseline). Both feed the same downstream pipeline.
      const useConsensus = cfg.consensus.n > 1;
      const judgeLabel = useConsensus ? `consensus×${cfg.consensus.n} (${cfg.consensus.rule})` : 'LLM judge';
      onNotice(`Stage D · ${borderline.length}/${allBundles.length} borderline → ${judgeLabel} (concurrency ${cfg.workflow.judgeConcurrency})`);
      await mapWithLimit(borderline, cfg.workflow.judgeConcurrency, async (b) => {
        if (ctx.abortSignal?.aborted) return;
        const sctx = staticStore.get(b.bundleId);
        let verdict: ConsensusVerdict | Awaited<ReturnType<typeof judgeBundleWithLlm>>;
        if (useConsensus) {
          // Sample the per-bundle LLM judge N times at the consensus temperature,
          // then combine + apply the heuristic precision-override (in @mcpvul/common).
          verdict = await judgeByConsensus(
            b,
            sctx,
            () => judgeBundleWithLlm(b, sctx, callModel, ctx.abortSignal, cfg.consensus.temperature),
            cfg.consensus,
          );
        } else {
          verdict = await judgeBundleWithLlm(b, sctx, callModel, ctx.abortSignal, cfg.llm.judgeTemperature);
        }
        if (!verdict) return;
        b.verdict = verdict;
        b.updatedAt = new Date().toISOString();
        const agree = (verdict as ConsensusVerdict).agreement;
        decisions.push({
          turn: decisions.length + 1,
          actionKind: AgentActionKind.JUDGE_BUNDLE,
          rationale: (verdict.explanation || '').slice(0, 200),
          strategySource: 'llm',
          toolName: useConsensus ? 'consensus_judge' : 'llm_judge',
          targetBundleIds: [b.bundleId],
          reasoning: '',
          decidedAt: new Date().toISOString(),
          resultSummary:
            `${verdict.verdict} (${(verdict.confidence * 100).toFixed(0)}%)` +
            (useConsensus && typeof agree === 'number' ? ` · agree ${(agree * 100).toFixed(0)}%` : ''),
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
