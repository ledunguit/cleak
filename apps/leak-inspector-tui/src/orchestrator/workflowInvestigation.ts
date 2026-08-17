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
import { AgentActionKind, DynamicMode, type AgentDecision, type LeakBundle, type VerdictResult } from '@cleak/common/types';
import { toProviderSettings, type RunConfig } from '@cleak/config';
import type { AgentMeta, InvestigationContext, InvestigationOutcome, InvestigationPhase } from './investigation';
import { CONTENT_CAPABLE_TOOLS } from '@cleak/common/mcp/tool-catalog';
import { mcpToolFlags } from '../domain/mcpToolPlan';
import { buildReadFileTool } from '../domain/readFileTool';
import { walkCFiles } from '../domain/fileWalk';
import { heuristicVerdict } from '../domain/judge';
import { StepLog } from '../domain/stepLog';
import { ScanEventName } from './events';
import { type AgentEventBridge, makeAgentEventHandler } from './toAgentEvents';
import { withHostContent, withHostPathMapping, withToolResultDedup } from './toolWrappers';
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
  DONE_HARNESS,
  buildDoneTool,
  staticSubAgentSystemPrompt,
  staticSubAgentUserMessage,
  dynamicWorkerSystemPrompt,
  dynamicWorkerUserMessage,
  harnessWorkerSystemPrompt,
  harnessWorkerUserMessage,
} from '../domain/subAgentPrompts';
import { judgeBundleWithLlm, shouldEscalate, isBorderline } from '../domain/llmJudge';
import { judgeCacheKey, readJudgeCache, writeJudgeCache } from '../domain/judgeVerdictCache';
import { judgeByConsensus, type ConsensusVerdict } from '@cleak/common/analysis/consensus-judge';
import { evidenceIndicatesLeak } from '@cleak/common/analysis/judge-shared';
import { needsTargetedDynamic } from '../domain/harnessEscalation';
import { verifyOwnershipClaims } from '../domain/ownershipVerification';
import { withHarnessInputCapture, type HarnessBuildInputCapture } from '../domain/harnessCapture';
import { coerceToObject } from '../domain/mcpResult';

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
    // Emit agent-activity notices for the TUI timeline
    if (ev.type === 'tool_use') {
      const argsPreview = JSON.stringify(ev.input).slice(0, 60);
      const isReadFile = ev.name === 'read_file' || ev.name === 'readFile';
      ctx.onAgentEvent?.({
        type: 'notice',
        text: `► ${isReadFile ? 'reading_file' : 'calling_mcp'} ${ev.name} ${argsPreview}`,
      } as any, agent);
    }
    if (ev.type === 'thinking' && ev.text?.trim()) {
      ctx.onAgentEvent?.({
        type: 'notice',
        text: `◎ ${ev.text.trim().slice(0, 60)}`,
      } as any, agent);
    }
  }
  state.usage.inputTokens += res.usage.inputTokens;
  state.usage.outputTokens += res.usage.outputTokens;
  ctx.onUsageDelta?.(res.usage);
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
  _onNotice: (text: string) => void,
): Promise<void> {
  if (ctx.abortSignal?.aborted) return;
  await mapWithLimit(groups, cfg.workflow.staticConcurrency, async (group, gi) => {
    if (ctx.abortSignal?.aborted) return;
    // P0-2: dedup identical evidence tool calls within the scan. The dedup sits
    // INSIDE the capture (host → capture → dedup → MCP) so the capture still folds
    // the (possibly cached) result into this group's static store — a cache hit
    // never leaves a bundle without its static evidence. The cache instance is the
    // scan-level one shared with deterministic enrichment, so a result the
    // orchestrator already holds is reused instead of re-invoked.
    const contentTool = (t: Tool): Tool =>
      withHostContent(
        withStaticContextCapture(ctx.caches ? withToolResultDedup(t, ctx.caches.tools) : t, state.staticStore, group),
        ctx.repoPath,
        ctx.caches?.files,
      );
    const tools: Tool[] = [
      ...contentStatic.map(contentTool),
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

/**
 * Stage B2 — for bundles the heuristic is still unsure about after the cheap
 * whole-binary Stage B run, synthesize a harness that calls JUST the suspicious
 * function/call-chain, compile it against the REAL project's own compiler flags,
 * and run it under a sanitizer. Each target gets its OWN local `DynamicRunStore` so
 * concurrent workers can't cross-attribute findings, and — since it targets exactly
 * one bundle — `reconcileDynamicEvidence` is scoped to `[bundle]` only. If the
 * single-shot (LLM-chosen) run comes back clean and the bundle is STILL borderline,
 * escalate deterministically (no extra LLM turn) to a short bounded libFuzzer run on
 * the SAME harness source the worker already built.
 */
async function stageTargetedHarness(
  allBundles: LeakBundle[],
  dynamicRaw: Tool[],
  readFileTool: Tool,
  cfg: RunConfig,
  ctx: InvestigationContext,
  state: WorkflowMutableState,
  callModel: CallModel,
  bridge: AgentEventBridge,
  toolCtx: ToolCtx,
  onNotice: (text: string) => void,
): Promise<void> {
  const harnessCfg = cfg.workflow.targetedHarness;
  if (!harnessCfg?.enabled || !ctx.buildCommand) return;
  const buildHarnessTool = dynamicRaw.find((t) => t.name === 'buildHarness');
  const fuzzTool = dynamicRaw.find((t) => t.name === 'libfuzzerRun');
  if (!buildHarnessTool) return; // analyzer doesn't expose the tool (older server) — nothing to do

  const targets = allBundles
    .filter((b) => needsTargetedDynamic(b, state.staticStore, !!ctx.buildCommand, harnessCfg.verifyConfirmedLeaks))
    // Borderline bundles first when both compete for maxHarnessesPerScan —
    // resolving ambiguity is worth more per harness than double-checking an
    // already-confident CONFIRMED_LEAK verdict (the `verifyConfirmedLeaks` case).
    .sort((a, b) => Number(isBorderline(b.verdict!)) - Number(isBorderline(a.verdict!)))
    .slice(0, harnessCfg.maxHarnessesPerScan);
  if (targets.length === 0) return;
  onNotice(`Stage B2 · targeted harness: ${targets.length} candidate(s) need deeper dynamic verification`);

  // `interproceduralFlow` needs the whole repo's file set to trace callees ACROSS
  // files (same requirement as scanController's enrich-stage use of it) — computed
  // ONCE for all targets, not per-bundle.
  const analyzerRepoPath = ctx.pathResolver.toAnalyzerPath(ctx.repoPath);
  const ipFiles = walkCFiles(ctx.repoPath).map((f) => ctx.pathResolver.toAnalyzerPath(f));

  await mapWithLimit(targets, harnessCfg.concurrency, async (bundle, i) => {
    if (ctx.abortSignal?.aborted) return;
    const staticCtx = state.staticStore.get(bundle.bundleId) ?? {};
    const localStore = createDynamicRunStore();

    // Best-effort call-chain hint: `interproceduralFlow` already computes which
    // OTHER files a leaking call chain touches — surface them as candidate
    // `closureFiles` so the worker isn't guessing blind on multi-file leaks. The
    // worker still decides what to actually pass (this narrows, doesn't replace,
    // its judgment).
    const suggestedClosureFiles: string[] = [];
    const fn = bundle.candidate.function_name;
    if (fn) {
      try {
        const ip = coerceToObject<{ paths?: Array<{ filePath?: string }> }>(
          await ctx.staticClient.callTool('interproceduralFlow', { rootPath: analyzerRepoPath, functionName: fn, files: ipFiles }),
        );
        const seen = new Set<string>();
        for (const p of ip.paths ?? []) {
          if (!p.filePath) continue;
          const hostPath = ctx.pathResolver.toHostPath(p.filePath);
          if (hostPath === bundle.candidate.file_path || seen.has(hostPath)) continue;
          seen.add(hostPath);
          suggestedClosureFiles.push(hostPath);
        }
      } catch {
        /* best-effort — the worker falls back to just the target's own file */
      }
    }
    const capture: HarnessBuildInputCapture = {};
    const tools: Tool[] = [
      ...dynamicRaw
        .filter((t) => t.name === 'buildHarness' || t.name === 'lsanRun' || t.name === 'asanRun')
        .map((t) =>
          withDynamicEvidenceCapture(
            withHostPathMapping(withHarnessInputCapture(t, capture), ctx.pathResolver),
            localStore,
            { targeted: true },
          ),
        ),
      readFileTool,
      buildDoneTool(DONE_HARNESS, 'Finish targeted harness synthesis for this candidate.'),
    ];
    const agent: AgentMeta = { id: `harness-${i}`, label: `harness ${i + 1}/${targets.length}`, kind: 'harness' };
    await runSubAgent(agent, {
      systemPrompt: harnessWorkerSystemPrompt(ctx.repoPath, ctx.buildCommand!, ctx.pathResolver.toAnalyzerPath(ctx.repoPath)),
      messages: [{ role: 'user', content: harnessWorkerUserMessage(bundle, staticCtx, suggestedClosureFiles) }],
      tools,
      maxTurns: Math.min(cfg.maxTurns, 12),
      terminalTools: new Set([DONE_HARNESS]),
      checkCompletion: () => {
        if (localStore.runs.some((r) => r.success) || capture.success === false) return null;
        return `No sanitizer run yet for this harness. Call buildHarness, then lsanRun/asanRun on the returned binaryPath, then call ${DONE_HARNESS}. Only tool calls advance the work.`;
      },
    }, state, callModel, bridge, toolCtx, cfg, ctx);

    reconcileDynamicEvidence(localStore, [bundle], ctx.pathResolver);
    if (localStore.runs.some((r) => r.success)) {
      bundle.dynamicCoverage = computeDynamicCoverage(localStore, bundle, true);
    }

    // Deterministic fuzz escalation — no extra LLM turn: only when the single-shot
    // run came back clean, the bundle is STILL borderline, and we actually have a
    // fuzzer tool + the exact harness inputs the worker used.
    const singleShotLeak = bundle.evidence.some(
      (e) => e.targeted && localStore.runs.some((r) => r.runId === e.runId) && evidenceIndicatesLeak(e),
    );
    const ranClean = localStore.runs.some((r) => r.success) && !singleShotLeak;
    if (ranClean && fuzzTool && capture.success && capture.input && bundle.verdict && isBorderline(bundle.verdict)) {
      onNotice(`Stage B2 · ${bundle.bundleId} clean on single-shot, escalating to ${(harnessCfg.fuzzBudgetMs / 1000).toFixed(0)}s fuzz`);
      try {
        const fuzzBuild = coerceToObject<{ success?: boolean; binaryPath?: string }>(
          await buildHarnessTool.call(
            { ...capture.input, entryStyle: 'fuzzer', timeoutSec: Math.ceil(harnessCfg.timeoutMs / 1000) },
            toolCtx,
          ),
        );
        if (fuzzBuild.success && fuzzBuild.binaryPath) {
          const fuzzCaptured = withDynamicEvidenceCapture(fuzzTool, localStore, { targeted: true });
          await fuzzCaptured.call(
            { binaryPath: fuzzBuild.binaryPath, maxTotalTimeSec: Math.floor(harnessCfg.fuzzBudgetMs / 1000) },
            toolCtx,
          );
          reconcileDynamicEvidence(localStore, [bundle], ctx.pathResolver);
          if (localStore.runs.some((r) => r.success)) {
            bundle.dynamicCoverage = computeDynamicCoverage(localStore, bundle, true);
          }
        }
      } catch (err: unknown) {
        onNotice(`Stage B2 · fuzz escalation for ${bundle.bundleId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

/**
 * Dynamic verification of static OWNERSHIP-TRANSFER claims — runs BEFORE the
 * heuristic-verdict loop (unlike Stage B2, which runs after) so a refuted claim
 * actually changes the outcome instead of arriving too late. See
 * `ownershipVerification.ts` module doc for the full rationale.
 */
async function stageOwnershipVerification(
  allBundles: LeakBundle[],
  cfg: RunConfig,
  ctx: InvestigationContext,
  state: WorkflowMutableState,
  onNotice: (text: string) => void,
): Promise<void> {
  const ownershipCfg = cfg.workflow.ownershipVerification;
  if (!ownershipCfg?.enabled || !ctx.buildCommand || !ctx.dynamicClient) return;
  const summary = await verifyOwnershipClaims(allBundles, state.staticStore, {
    repoPath: ctx.repoPath,
    buildCommand: ctx.buildCommand,
    staticClient: ctx.staticClient,
    dynamicClient: ctx.dynamicClient,
    pathResolver: ctx.pathResolver,
    cfg: ownershipCfg,
    onNotice,
  });
  if (summary.confirmed > 0 || summary.refuted > 0) {
    onNotice(`Stage · ownership verify: ${summary.confirmed} confirmed, ${summary.refuted} refuted (exoneration cleared)`);
  }
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
    ctx.onUsageDelta?.(u);
  };
  const recordJudgeDecision = (b: LeakBundle, verdict: VerdictResult | ConsensusVerdict, toolName: string): void => {
    const agree = (verdict as ConsensusVerdict).agreement;
    state.decisions.push({
      turn: state.decisions.length + 1,
      actionKind: AgentActionKind.JUDGE_BUNDLE,
      rationale: (verdict.explanation || '').slice(0, 200),
      strategySource: 'llm',
      toolName,
      targetBundleIds: [b.bundleId],
      reasoning: '',
      decidedAt: new Date().toISOString(),
      resultSummary:
        `${verdict.verdict} (${(verdict.confidence * 100).toFixed(0)}%)` +
        (typeof agree === 'number' ? ` · agree ${(agree * 100).toFixed(0)}%` : ''),
    });
  };

  let cacheHits = 0;
  await mapWithLimit(borderline, cfg.workflow.judgeConcurrency, async (b) => {
    if (ctx.abortSignal?.aborted) return;
    const sctx = staticStore.get(b.bundleId);

    // Disk-persisted judge-verdict cache (default on) — a bundle whose evidence
    // is byte-identical to a previously-judged one skips the LLM entirely,
    // including every consensus sample. See judgeVerdictCache.ts for why this
    // caches the final combined decision, not individual consensus samples.
    const cacheKey = cfg.judgeCache.enabled
      ? judgeCacheKey(b, sctx, ctx.projectOwnershipNotes, cfg.consensus, ctx.caches?.files)
      : null;
    if (cacheKey) {
      const cached = readJudgeCache(ctx.repoPath, cacheKey);
      if (cached) {
        cacheHits++;
        onNotice(`Stage D · ${b.bundleId} — judge cache hit, skipping LLM`);
        b.verdict = cached;
        b.updatedAt = new Date().toISOString();
        recordJudgeDecision(b, cached, useConsensus ? 'consensus_judge_cached' : 'llm_judge_cached');
        return;
      }
    }

    let verdict: ConsensusVerdict | Awaited<ReturnType<typeof judgeBundleWithLlm>>;
    if (useConsensus) {
      // Sample the per-bundle LLM judge N times at the consensus temperature,
      // then combine + apply the heuristic precision-override (in @cleak/common).
      verdict = await judgeByConsensus(
        b,
        sctx,
        () => judgeBundleWithLlm(b, sctx, callModel, ctx.abortSignal, cfg.consensus.temperature, onNotice, ctx.projectOwnershipNotes, addUsage, ctx.caches?.files),
        cfg.consensus,
      );
    } else {
      verdict = await judgeBundleWithLlm(b, sctx, callModel, ctx.abortSignal, cfg.llm.judgeTemperature, onNotice, ctx.projectOwnershipNotes, addUsage, ctx.caches?.files);
    }
    if (!verdict) return;
    b.verdict = verdict;
    b.updatedAt = new Date().toISOString();
    if (cacheKey) writeJudgeCache(ctx.repoPath, cacheKey, verdict, cfg.judgeCache.maxEntries);
    recordJudgeDecision(b, verdict, useConsensus ? 'consensus_judge' : 'llm_judge');
  });
  if (cfg.judgeCache.enabled && borderline.length > 0) {
    onNotice(`Stage D · judge cache: ${cacheHits}/${borderline.length} hit`);
  }
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
      const readFileTool = buildReadFileTool(ctx.repoPath, ctx.caches?.files);

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

      // MUST run before the heuristic-verdict loop below — it corrects
      // `staticStore`/`bundle.staticEvidence` in place, so a refuted ownership
      // claim is reflected in the FIRST verdict computation, not a later patch.
      await stageOwnershipVerification(allBundles, cfg, ctx, state, onNotice);

      // Hoisted from Stage D so Stage B2's escalation gate (which needs a verdict to
      // judge "still borderline") can run before the LLM judge, not after it.
      for (const b of allBundles) {
        if (!b.verdict) b.verdict = heuristicVerdict(b, state.staticStore.get(b.bundleId) ?? {});
      }

      await stageTargetedHarness(allBundles, dynamicRaw, readFileTool, cfg, ctx, state, callModel, bridge, toolCtx, onNotice);

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
