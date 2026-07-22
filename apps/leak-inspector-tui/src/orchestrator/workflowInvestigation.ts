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
} from '@cleak/agent-core';
import { AgentActionKind, DynamicMode, type AgentDecision, type LeakBundle } from '@cleak/common/types';
import type { RunConfig } from '../config';
import type { AgentMeta, InvestigationContext, InvestigationOutcome, InvestigationPhase } from './investigation';
import { mcpToolFlags, CONTENT_CAPABLE_TOOLS } from '../domain/mcpToolPlan';
import { buildReadFileTool } from '../domain/readFileTool';
import { heuristicVerdict } from '../domain/judge';
import { StepLog } from '../domain/stepLog';
import { ScanEventName } from './events';
import { type AgentEventBridge, makeAgentEventHandler } from './toAgentEvents';
import { withHostContent, withHostPathMapping, toProviderSettings } from './toolWrappers';
import { type StaticContextStore, withStaticContextCapture } from '../domain/staticContext';
import {
  createDynamicRunStore,
  type DynamicRunStore,
  withDynamicEvidenceCapture,
  reconcileDynamicEvidence,
  computeDynamicCoverage,
  runDeterministicDynamic,
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
import { judgeByConsensus, type ConsensusVerdict } from '@cleak/common/analysis/consensus-judge';

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

export interface WorkflowInvestigationOptions {
  /** Agentic tool selection (the ablation `tool_selector` axis). When TRUE (default),
   * Stage A is a fan-out of LLM sub-agents that pick static tools step-by-step, and
   * Stage B may fall back to an LLM worker. When FALSE, Stage A is skipped entirely —
   * static evidence comes from the deterministic enrichment stage (scanController's
   * `enrich`), and Stage B runs the deterministic recipe only (no LLM worker). The
   * LLM-fusion judge (Stage D) runs in both cases — this axis is independent of it. */
  toolSelect?: boolean;
}

// ── Shared mutable state for the investigation workflow ──

export interface WorkflowMutableState {
  staticStore: StaticContextStore;
  dynStore: DynamicRunStore;
  usage: { inputTokens: number; outputTokens: number };
  transcripts: Message[];
  decisions: AgentDecision[];
  stepLog: StepLog;
  totalTurns: number;
}

async function runSubAgent(
  agent: AgentMeta,
  params: {
    systemPrompt: string;
    messages: Message[];
    tools: Tool[];
    maxTurns: number;
    terminalTools: Set<string>;
    checkCompletion?: () => string | null;
  },
  state: WorkflowMutableState,
  callModel: CallModel,
  bridge: AgentEventBridge,
  toolCtx: ToolCtx,
  cfg: RunConfig,
  ctx: InvestigationContext,
): Promise<void> {
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
    state.stepLog.record(ev);
  }
  state.usage.inputTokens += res.usage.inputTokens;
  state.usage.outputTokens += res.usage.outputTokens;
  state.totalTurns += res.turns;
  state.transcripts.push(...res.messages);
}

async function stageStaticEvidence(
  groups: LeakBundle[][],
  cfg: RunConfig,
  contentStatic: Tool[],
  readFileTool: Tool,
  ctx: InvestigationContext,
  state: WorkflowMutableState,
  callModel: CallModel,
  bridge: AgentEventBridge,
  toolCtx: ToolCtx,
  onNotice: (text: string) => void,
): Promise<void> {
  if (ctx.abortSignal?.aborted) return;
  await mapWithLimit(groups, cfg.workflow.staticConcurrency, async (group, gi) => {
    if (ctx.abortSignal?.aborted) return;
    const tools: Tool[] = [
      ...contentStatic.map((t) => withHostContent(withStaticContextCapture(t, state.staticStore, group), ctx.repoPath)),
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
        const missing = group.filter((b) => !state.staticStore.has(b.bundleId));
        if (missing.length === 0) return null;
        const ids = missing.map((b) => b.bundleId).join(', ');
        return `You stopped, but ${missing.length} candidate(s) have NO static evidence yet: ${ids}. Run functionSummary/pathConstraints/astScan/ownershipConventions for them, then call ${DONE_STATIC}. Only tool calls advance the work.`;
      },
    }, state, callModel, bridge, toolCtx, cfg, ctx);
  });
}

async function stageDynamicEvidence(
  wantDynamic: boolean,
  ctx: InvestigationContext,
  dynamicRaw: Tool[],
  readFileTool: Tool,
  cfg: RunConfig,
  state: WorkflowMutableState,
  callModel: CallModel,
  bridge: AgentEventBridge,
  toolCtx: ToolCtx,
  onNotice: (text: string) => void,
  toolSelect: boolean,
  allBundles: LeakBundle[],
): Promise<void> {
  if (!wantDynamic) return;
  if (ctx.dynamicAlreadyRan) {
    onNotice('Stage B · dynamic already ran during dynamic-only discovery — skipping (coverage preserved)');
    return;
  }
  if (dynamicRaw.length === 0) {
    onNotice('dynamic enabled but no dynamic tools loaded — analyzer unreachable; running static-only');
    return;
  }
  // DETERMINISTIC PATH: a known build_command → run a FIXED recipe (buildTarget →
  // lsanRun) with no LLM, so the run — and therefore coverage/verdicts — is
  // reproducible. The LLM only drives the run when the build system is unknown.
  if (ctx.buildCommand) {
    onNotice('Stage B · dynamic evidence: deterministic recipe (buildTarget → lsanRun, no LLM)');
    const ok = await runDeterministicDynamic({
      tools: dynamicRaw,
      store: state.dynStore,
      repoPath: ctx.repoPath,
      buildCommand: ctx.buildCommand,
      pathResolver: ctx.pathResolver,
      toolCtx,
      onNotice,
    });
    if (ok) return;
    if (!toolSelect) {
      onNotice('Stage B · deterministic recipe produced no run — tool_selector off, skipping LLM worker');
      return;
    }
    onNotice('Stage B · deterministic recipe produced no run — falling back to the LLM worker');
  }
  if (!toolSelect) {
    onNotice('Stage B · dynamic skipped (tool_selector off + no build_command for the deterministic recipe)');
    return;
  }
  onNotice('Stage B · dynamic evidence: 1 LLM worker (build once + sanitizers)');
  // The sanitizer tools are wrapped so their findings are captured into
  // `dynStore` DETERMINISTICALLY — the LLM only drives build/run; it can no
  // longer add or omit evidence that changes a verdict. There is no
  // discretionary evidence-recording tool — the wrapper is the sole source.
  const tools: Tool[] = [
    ...dynamicRaw.map((t) => withDynamicEvidenceCapture(withHostPathMapping(t, ctx.pathResolver), state.dynStore)),
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
      if (state.dynStore.runs.some((r) => r.success)) return null;
      return `No successful sanitizer run yet. buildTarget (with a sanitizer flag), then run lsanRun/asanRun/valgrindMemcheck, then call ${DONE_DYNAMIC}. Only tool calls advance the work.`;
    },
  }, state, callModel, bridge, toolCtx, cfg, ctx);
}

async function stageHybridJudge(
  allBundles: LeakBundle[],
  staticStore: StaticContextStore,
  cfg: RunConfig,
  ctx: InvestigationContext,
  callModel: CallModel,
  onNotice: (text: string) => void,
  state: WorkflowMutableState,
): Promise<void> {
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
  // Accumulate Stage-D judge token usage into the same `usage` ledger the agentic
  // loops feed — previously the judge's tokens were dropped, so the eval reported 0.
  const addUsage = (u: { inputTokens: number; outputTokens: number }) => {
    state.usage.inputTokens += u.inputTokens;
    state.usage.outputTokens += u.outputTokens;
  };
  await mapWithLimit(borderline, cfg.workflow.judgeConcurrency, async (b) => {
    if (ctx.abortSignal?.aborted) return;
    const sctx = staticStore.get(b.bundleId);
    let verdict: ConsensusVerdict | Awaited<ReturnType<typeof judgeBundleWithLlm>>;
    if (useConsensus) {
      // Sample the per-bundle LLM judge N times at the consensus temperature,
      // then combine + apply the heuristic precision-override (in @cleak/common).
      verdict = await judgeByConsensus(
        b,
        sctx,
        () => judgeBundleWithLlm(b, sctx, callModel, ctx.abortSignal, cfg.consensus.temperature, onNotice, ctx.projectOwnershipNotes, addUsage),
        cfg.consensus,
      );
    } else {
      verdict = await judgeBundleWithLlm(b, sctx, callModel, ctx.abortSignal, cfg.llm.judgeTemperature, onNotice, ctx.projectOwnershipNotes, addUsage);
    }
    if (!verdict) return;
    b.verdict = verdict;
    b.updatedAt = new Date().toISOString();
    const agree = (verdict as ConsensusVerdict).agreement;
    state.decisions.push({
      turn: state.decisions.length + 1,
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
}

export function buildWorkflowInvestigationPhase(
  cfg: RunConfig,
  dynamicMode: DynamicMode,
  opts: WorkflowInvestigationOptions = {},
): InvestigationPhase {
  const toolSelect = opts.toolSelect ?? true;
  return {
    async run(candidates, ctx: InvestigationContext): Promise<InvestigationOutcome> {
      const state: WorkflowMutableState = {
        staticStore: new Map(),
        dynStore: createDynamicRunStore(),
        usage: { inputTokens: 0, outputTokens: 0 },
        transcripts: [],
        decisions: [],
        stepLog: new StepLog(),
        totalTurns: 0,
      };
      const MAIN: AgentMeta = { id: 'main', label: 'main', kind: 'main' };
      const onNotice = (text: string) => {
        const ev: AgentEvent = { type: 'notice', text };
        ctx.onAgentEvent?.(ev, MAIN);
        state.stepLog.record(ev);
      };
      const callModel: CallModel = buildCallModel(toProviderSettings(cfg), () => globalThis.crypto.randomUUID(), onNotice);
      const bridge = makeAgentEventHandler(ctx.emitter);
      const toolCtx: ToolCtx = { cwd: ctx.repoPath, requestPermission: ctx.requestPermission, abortSignal: ctx.abortSignal };

      const allBundles = candidates.getAllBundles();

      // Load static + dynamic tool catalogs in parallel.
      const wantDynamic = dynamicMode !== DynamicMode.OFF && !!ctx.dynamicClient;
      const [staticRaw, dynamicRaw] = await Promise.all([
        loadMcpTools(ctx.staticClient, mcpToolFlags),
        wantDynamic ? loadMcpTools(ctx.dynamicClient!, mcpToolFlags) : Promise.resolve([] as Tool[]),
      ]);
      const contentStatic = staticRaw.filter((t) => CONTENT_CAPABLE_TOOLS.has(t.name));
      const readFileTool = buildReadFileTool(ctx.repoPath);

      ctx.emitter.emit(ScanEventName.INVESTIGATION_STARTED, {
        candidates: allBundles.length,
        tools: contentStatic.length + dynamicRaw.length,
        maxTurns: cfg.maxTurns,
      });

      const groups = groupByFileAffinity(allBundles, cfg.workflow.staticGroupSize);
      if (toolSelect) {
        onNotice(`Stage A · static evidence: ${groups.length} sub-agent(s), concurrency ${cfg.workflow.staticConcurrency}`);
      } else {
        onNotice('Stage A · static evidence: deterministic enrichment (tool_selector off — no agentic sub-agents)');
      }
      const staticFanout = !toolSelect
        ? Promise.resolve()
        : stageStaticEvidence(groups, cfg, contentStatic, readFileTool, ctx, state, callModel, bridge, toolCtx, onNotice);

      const dynamicWorker = stageDynamicEvidence(wantDynamic, ctx, dynamicRaw, readFileTool, cfg, state, callModel, bridge, toolCtx, onNotice, toolSelect, allBundles);

      await Promise.all([staticFanout, dynamicWorker]);

      if (!ctx.dynamicAlreadyRan) {
        reconcileDynamicEvidence(state.dynStore, allBundles, ctx.pathResolver);
        for (const b of allBundles) b.dynamicCoverage = computeDynamicCoverage(state.dynStore, b, wantDynamic);
      }

      onNotice(`Stage C · synthesize: ${state.staticStore.size}/${allBundles.length} candidates have static context`);

      await stageHybridJudge(allBundles, state.staticStore, cfg, ctx, callModel, onNotice, state);

      bridge.finishPendingPhases();
      ctx.emitter.emit(ScanEventName.INVESTIGATION_FINISHED, {
        turns: state.totalTurns,
        reason: 'finalized',
        verdicts: allBundles.filter((b) => b.verdict).length,
      });

      return {
        reason: 'finalized',
        turns: state.totalTurns,
        agentDecisions: state.decisions,
        transcript: state.transcripts as unknown[],
        usage: state.usage,
        staticContext: Object.fromEntries(state.staticStore) as Record<string, Record<string, any>>,
        stepsLog: state.stepLog.toMarkdown(),
      };
    },
  };
}
