/**
 * Headless scan runner — drives the same scan controller as the TUI, but emits
 * events as JSON lines (to results/<scanId>/events.jsonl and optionally stdout)
 * and writes the report artifacts. This is the surface the experiment scripts
 * call; it produces the reproducible outputs the thesis evaluates.
 */

import { resolve, basename, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { McpClient, buildCallModel } from '@cleak/agent-core';
import { AnalysisMode, DynamicMode } from '@cleak/common/types';
import { loadConfig, type ConsensusJudgeConfig, type RunConfig, toProviderSettings } from '@cleak/config';
import { loadOrProfileAllocators, profileCachePath } from '../domain/allocatorProfiler';
import { verifyAllocatorProfile } from '../domain/allocatorVerification';
import { decideStrategy } from '../domain/strategist';
import { buildPathResolver, type PathResolver } from '../domain/pathResolver';
import { ScanEmitter, JsonlFileSink, MultiSink, CallbackSink, type EventSink, type ScanEvent } from '../orchestrator/events';
import { runScan, type ScanResult } from '../orchestrator/scanController';
import { buildWorkflowInvestigationPhase } from '../orchestrator/workflowInvestigation';
import { type InvestigationPhase } from '../orchestrator/investigation';
import { scanDir, writeReports, writeScanMetrics, type ReportFormatOpt } from '../domain/reportSink';
import { computeScanMetrics } from '../domain/scanMetrics';

export interface HeadlessOptions {
  repo: string;
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  /** A canonical provider type or a named profile (see RunConfig.provider). */
  provider?: string;
  /** Custom LLM endpoint overrides (e.g. an OpenAI-compatible base URL/model/key). */
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  format: string;
  build?: string;
  /** Stage B2 — targeted per-candidate harness synthesis (opt-in, experimental).
   * Overrides the saved config's `workflow.targetedHarness.enabled` to true. */
  harness?: boolean;
  /** Dynamic verification of the LLM-discovered allocator/deallocator profile
   * (opt-in, experimental). Overrides `workflow.allocatorVerification.enabled`. */
  verifyAllocators?: boolean;
  /** Widen Stage B2 to also double-check CONFIRMED_LEAK verdicts (opt-in,
   * experimental). Overrides `workflow.targetedHarness.verifyConfirmedLeaks`. */
  verifyConfirmed?: boolean;
  /** Dynamic verification of static ownership-transfer claims (opt-in,
   * experimental). Overrides `workflow.ownershipVerification.enabled`. */
  verifyOwnership?: boolean;
  /** Per-project factory allocators / custom deallocators (≈ LAMeD AllocSource /
   * FreeSink) — threaded to candidateScan so wrapper-named allocators are found. */
  extraAllocators?: string[];
  extraDeallocators?: string[];
  /** Where the allocator/deallocator names come from. 'auto' (default): use the LLM
   * profiler when in llm_assisted mode and none were supplied; 'llm': always profile;
   * 'none': never (current behavior / deterministic). When extraAllocators are passed
   * explicitly (e.g. the eval harness from a frozen manifest), the profiler is skipped. */
  allocatorsFrom?: 'auto' | 'llm' | 'none';
  /** Adaptive strategist: 'auto' lets an LLM planner decide the analysis plan
   * (currently: skip the dynamic stage on unbuildable repos) for THIS project; 'off'
   * (default) keeps the requested pipeline. Off in the benchmark ⇒ eval is deterministic. */
  strategy?: 'auto' | 'off';
  /** Deterministic static enrichment (alloc→free pairing + feasible leak paths).
   * Explicit override of the `STATIC_ENRICH=on` env gate (baseline sweep). */
  enrich?: boolean;
  /** Agentic tool selection (ablation `tool_selector` axis). Default true. When
   * false, the llm_assisted investigation skips the agentic static fan-out (uses the
   * deterministic enrichment) and the deterministic dynamic recipe only. */
  toolSelect?: boolean;
  /** Static candidate discovery (ablation `static` axis). Default true. When false,
   * discovery is dynamic-only (build + LSan → synthesize sites); needs a buildCommand
   * and --dynamic != off. */
  staticDiscovery?: boolean;
  /** Which static evidence tools the enrich stage runs (tool-level ablation). */
  staticTools?: string[];
  fileLimit?: number;
  staticUrl?: string;
  dynamicUrl?: string;
  /** Host repo root (for path mapping when analyzers run in Docker). */
  hostRoot?: string;
  /** Analyzer-visible root, e.g. /workspace (Docker mount). */
  analyzerRoot?: string;
  quiet?: boolean;
  /** Consensus-judge override (ablation): partial knobs merged over env defaults. */
  consensus?: Partial<ConsensusJudgeConfig>;
  /** Judge-verdict disk-cache override. Default (unset) leaves the config value
   * (true) — set `false` for ablation/stability experiments that intentionally
   * re-judge the SAME evidence across repeat runs to measure genuine LLM
   * run-to-run variance, which a cache hit would otherwise mask entirely. */
  judgeCacheEnabled?: boolean;
  /** Stop the scan when the LLM judge hits quota/rate-limit exhaustion instead
   * of silently falling back to the heuristic verdict. Default (unset) leaves
   * the config value (`llm.pauseOnQuotaExhausted`, true). */
  pauseOnQuotaExhausted?: boolean;
  /** Live ScanEvent stream (used by the eval harness to show per-case phase). */
  onEvent?: (ev: ScanEvent) => void;
  /** Interrupt discovery + the agentic loop (e.g. eval cancel). */
  signal?: AbortSignal;
  /** Fired on every token-usage increment (allocator profiling, strategist, Stage
   * A/D) — lets a caller track live spend without waiting for the scan to finish
   * (e.g. the eval harness's per-case cost cap). Purely observational. */
  onUsageDelta?: (d: { inputTokens: number; outputTokens: number }) => void;
}

export interface HeadlessResult extends ScanResult {
  scanId: string;
  dir: string;
  files: string[];
  /** Total MCP tool calls (static + dynamic) made during this scan — an efficiency
   *  metric for the ablation (#MCP calls). */
  mcpCalls: number;
  /** LLM token usage for the whole scan — investigation phase (Stage A/D) plus
   * pre-investigation allocator-profiler/strategist calls, which used to be
   * dropped entirely. */
  usage: { inputTokens: number; outputTokens: number };
  /** Count of LLM calls during the investigation phase (Stage A/B/C/D) whose
   * response came back truncated at the token budget (`stopReason ===
   * 'max_tokens'`) — see `InvestigationOutcome.truncatedCalls`. */
  truncatedCalls: number;
}

export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const nz = (s?: string) => (s && s.trim() ? s : undefined);
  const cfg = loadConfig({
    provider: opts.provider,
    llm: { baseUrl: nz(opts.baseUrl), model: nz(opts.model), apiKey: nz(opts.apiKey), pauseOnQuotaExhausted: opts.pauseOnQuotaExhausted },
    ...(opts.staticUrl ? { staticUrl: opts.staticUrl } : {}),
    ...(opts.dynamicUrl ? { dynamicUrl: opts.dynamicUrl } : {}),
    ...(opts.hostRoot ? { hostRoot: opts.hostRoot } : {}),
    ...(opts.analyzerRoot ? { analyzerRoot: opts.analyzerRoot } : {}),
    ...(opts.consensus ? { consensus: opts.consensus as ConsensusJudgeConfig } : {}),
    ...(opts.judgeCacheEnabled !== undefined ? { judgeCache: { enabled: opts.judgeCacheEnabled } } : {}),
  });
  // `workflow` isn't deep-merged by loadConfig's overrides (only `consensus`/`llm`
  // are) — flip just this one nested flag after defaults are resolved instead of
  // risking a shallow-merge that would drop staticConcurrency/staticGroupSize/etc.
  if (opts.harness) cfg.workflow.targetedHarness.enabled = true;
  if (opts.verifyAllocators) cfg.workflow.allocatorVerification.enabled = true;
  if (opts.verifyConfirmed) cfg.workflow.targetedHarness.verifyConfirmedLeaks = true;
  if (opts.verifyOwnership) cfg.workflow.ownershipVerification.enabled = true;

  const repoPath = resolve(opts.repo);
  if (!existsSync(repoPath)) throw new Error(`Repository path not found: ${repoPath}`);

  const analysisMode = opts.mode === 'llm_assisted' ? AnalysisMode.LLM_ASSISTED : AnalysisMode.NO_LLM;
  // Loud guard: a custom OpenAI-compatible endpoint can't run without a base URL + model.
  if (analysisMode === AnalysisMode.LLM_ASSISTED && cfg.llm.provider === 'openai-compat' && (!cfg.llm.baseUrl || !cfg.llm.model)) {
    throw new Error(
      `provider 'openai-compat' needs a base URL AND a model — set them in the config file ` +
        `or pass --base-url/--model. Got baseUrl='${cfg.llm.baseUrl}', model='${cfg.llm.model}'.`,
    );
  }
  let dynamicMode =
    opts.dynamic === 'aggressive'
      ? DynamicMode.AGGRESSIVE
      : opts.dynamic === 'selective'
        ? DynamicMode.SELECTIVE
        : DynamicMode.OFF;

  const scanId = makeScanId(repoPath);
  const dir = scanDir(cfg.resultsDir, scanId);

  const sinks: EventSink[] = [new JsonlFileSink(join(dir, 'events.jsonl'), !opts.quiet)];
  if (opts.onEvent) sinks.push(new CallbackSink(opts.onEvent));
  const emitter = new ScanEmitter(new MultiSink(sinks));

  const staticClient = new McpClient(cfg.staticUrl, 'static', { correlationId: scanId });
  let dynamicClient = dynamicMode !== DynamicMode.OFF ? new McpClient(cfg.dynamicUrl, 'dynamic', { correlationId: scanId }) : undefined;
  const pathResolver = buildPathResolver({
    hostRoot: cfg.hostRoot,
    analyzerRoot: cfg.analyzerRoot,
    dynamicEnabled: dynamicMode !== DynamicMode.OFF,
    cwd: process.cwd(),
  });

  const investigation =
    analysisMode === AnalysisMode.LLM_ASSISTED
      ? buildWorkflowInvestigationPhase(cfg, dynamicMode, { toolSelect: opts.toolSelect ?? true })
      : undefined;

  // Allocator profiling + strategist run BEFORE the investigation phase, from
  // ad-hoc `callModel` instances of their own — accumulate their token usage
  // here so it merges into the final result instead of vanishing (previously
  // dropped entirely, not even counted in the combined total).
  const preUsage = { inputTokens: 0, outputTokens: 0 };
  const addPreUsage = (u: { inputTokens: number; outputTokens: number }) => {
    preUsage.inputTokens += u.inputTokens;
    preUsage.outputTokens += u.outputTokens;
    opts.onUsageDelta?.(u);
  };

  const { extraAllocators, extraDeallocators, ownershipNotes } = await runAllocatorProfile(
    repoPath,
    cfg,
    opts,
    analysisMode,
    staticClient,
    dynamicClient,
    pathResolver,
    addPreUsage,
  );

  const adaptiveResult = await runAdaptiveStrategy(repoPath, cfg, dynamicMode, dynamicClient, opts, analysisMode, extraAllocators, extraDeallocators, addPreUsage);
  dynamicMode = adaptiveResult.dynamicMode;
  dynamicClient = adaptiveResult.dynamicClient;

  const startedAt = Date.now();
  try {
    return await runScanAndReport(cfg, dir, opts, startedAt, staticClient, dynamicClient, analysisMode, scanId, repoPath, dynamicMode, extraAllocators, extraDeallocators, ownershipNotes, emitter, pathResolver, investigation, preUsage);
  } catch (err) {
    // Live counters (already in scope regardless of throw site) — lets a caller
    // that aborted mid-scan (e.g. a per-case budget cap) report what was actually
    // spent instead of a misleading 0, without needing usage tracked all the way
    // up through the throw itself.
    if (err instanceof Error) {
      (err as Error & { partialMcpCalls?: number }).partialMcpCalls = staticClient.callCount + (dynamicClient?.callCount ?? 0);
    }
    throw err;
  } finally {
    await staticClient.close();
    await dynamicClient?.close();
  }
}

// ── Extracted sub-stages ─────────────────────────────────────────────────────

/**
 * LLM allocator profiling — discover the project's alloc/free API instead of
 * hardcoding it. Skipped when allocators are supplied explicitly (the eval
 * harness passes a frozen manifest list ⇒ deterministic) or disabled via 'none'.
 * Default 'auto' = profile only in llm_assisted mode. Discovered names feed
 * the SAME extraAllocators plumbing; the result is grep-verified + cached per repo.
 */
async function runAllocatorProfile(
  repoPath: string,
  cfg: RunConfig,
  opts: HeadlessOptions,
  analysisMode: AnalysisMode,
  staticClient: McpClient,
  dynamicClient: McpClient | undefined,
  pathResolver: PathResolver,
  onUsage: (u: { inputTokens: number; outputTokens: number }) => void,
): Promise<{ extraAllocators?: string[]; extraDeallocators?: string[]; ownershipNotes?: string[] }> {
  let extraAllocators = opts.extraAllocators;
  let extraDeallocators = opts.extraDeallocators;
  let ownershipNotes: string[] | undefined;
  const allocatorsFrom = opts.allocatorsFrom ?? 'auto';
  const wantProfile =
    !extraAllocators?.length &&
    allocatorsFrom !== 'none' &&
    (allocatorsFrom === 'llm' || analysisMode === AnalysisMode.LLM_ASSISTED);
  if (wantProfile) {
    const callModel = buildCallModel(toProviderSettings(cfg), () => globalThis.crypto.randomUUID());
    const notice = opts.quiet ? undefined : (r: string) => process.stderr.write(`  ${r}\n`);
    let profile = await loadOrProfileAllocators(repoPath, callModel, {
      signal: opts.signal,
      temperature: cfg.llm.temperature,
      onNotice: notice,
      onUsage,
    });
    // Dynamic verification (opt-in): harness-check each candidate name instead of
    // trusting the LLM's textual grep-verify alone. Needs a build command AND a
    // live dynamic-analyzer connection — same preconditions as Stage B2's
    // deterministic recipe. `verifiedAt` on a cache hit means a prior run already
    // did this — skip so a re-scan doesn't re-pay the harness-build cost.
    const verifyCfg = cfg.workflow.allocatorVerification;
    if (profile && !profile.verifiedAt && verifyCfg?.enabled && opts.build && dynamicClient) {
      const { profile: verified, summary } = await verifyAllocatorProfile(profile, {
        repoPath,
        buildCommand: opts.build,
        staticClient,
        dynamicClient,
        pathResolver,
        cfg: verifyCfg,
        onNotice: notice,
      });
      profile = verified;
      try {
        mkdirSync(join(repoPath, '.cleak'), { recursive: true });
        writeFileSync(profileCachePath(repoPath), JSON.stringify(profile, null, 2));
      } catch {
        /* re-caching the verified profile is best-effort */
      }
      if (!opts.quiet) {
        const refuted = Object.values(summary.allocators).filter((s) => s === 'refuted').length;
        const confirmed =
          Object.values(summary.allocators).filter((s) => s === 'confirmed').length +
          Object.values(summary.deallocators).filter((s) => s === 'confirmed').length;
        process.stdout.write(`  allocator verify: ${confirmed} confirmed, ${refuted} refuted (dropped)\n`);
      }
    }
    if (profile) {
      extraAllocators = profile.allocators;
      extraDeallocators = profile.deallocators;
      ownershipNotes = profile.ownershipNotes;
      if (!opts.quiet) {
        process.stdout.write(
          `  allocator profile: ${profile.allocators.length} allocators, ${profile.deallocators.length} deallocators (LLM-discovered)\n`,
        );
      }
    }
  }
  return { extraAllocators, extraDeallocators, ownershipNotes };
}

/**
 * Adaptive strategist: an LLM planner picks the analysis plan for THIS project.
 * v0 wires `runDynamic` — skip the expensive dynamic stage on a repo with no
 * build system (it can't build ⇒ no recall lost). OPT-IN (--strategy auto) and
 * never engaged by the benchmark (which passes an explicit dynamic mode), so eval
 * determinism + the Juliet baseline are untouched.
 */
async function runAdaptiveStrategy(
  repoPath: string,
  cfg: RunConfig,
  dynamicMode: DynamicMode,
  dynamicClient: McpClient | undefined,
  opts: HeadlessOptions,
  analysisMode: AnalysisMode,
  extraAllocators: string[] | undefined,
  extraDeallocators: string[] | undefined,
  onUsage: (u: { inputTokens: number; outputTokens: number }) => void,
): Promise<{ dynamicMode: DynamicMode; dynamicClient: McpClient | undefined }> {
  if (opts.strategy === 'auto' && analysisMode === AnalysisMode.LLM_ASSISTED) {
    const callModel = buildCallModel(toProviderSettings(cfg), () => globalThis.crypto.randomUUID());
    const plan = await decideStrategy(repoPath, callModel, {
      profileSummary: extraAllocators?.length ? `${extraAllocators.length} allocators, ${extraDeallocators?.length ?? 0} deallocators` : undefined,
      temperature: cfg.llm.temperature,
      signal: opts.signal,
      onNotice: opts.quiet ? undefined : (r) => process.stderr.write(`  ${r}\n`),
      onUsage,
    });
    if (!opts.quiet) {
      process.stdout.write(`  strategy: runDynamic=${plan.runDynamic} judge=${plan.judge} staticDepth=${plan.staticDepth}${plan.rationale ? ` — ${plan.rationale}` : ''}\n`);
    }
    // Guardrail: the strategist may only DROP dynamic for an UNBUILDABLE repo (its
    // legit use: "no build system ⇒ can't run ⇒ no recall lost"). When a buildCommand
    // IS present the case is runnable, and the measured cost of skipping dynamic is
    // severe — runtime confirmation is the false-positive killer, so disabling it on
    // buildable cases reintroduces FPs (B6a/B7 had 152/184 bundles forced dynamic_off
    // → P 1.00→0.90/0.76). So we honor runDynamic=false ONLY without a buildCommand.
    if (!plan.runDynamic && dynamicMode !== DynamicMode.OFF) {
      if (opts.build) {
        if (!opts.quiet) process.stdout.write(`  strategy: runDynamic=false ignored (buildCommand present — dynamic kept)\n`);
      } else {
        await dynamicClient?.close();
        dynamicClient = undefined;
        dynamicMode = DynamicMode.OFF;
      }
    }
  }
  return { dynamicMode, dynamicClient };
}

/**
 * Run the scan, write reports, compute metrics, and return the HeadlessResult.
 * This is the core of the try-block body, extracted for readability.
 */
async function runScanAndReport(
  cfg: RunConfig,
  dir: string,
  opts: HeadlessOptions,
  startedAt: number,
  staticClient: McpClient,
  dynamicClient: McpClient | undefined,
  analysisMode: AnalysisMode,
  scanId: string,
  repoPath: string,
  dynamicMode: DynamicMode,
  extraAllocators: string[] | undefined,
  extraDeallocators: string[] | undefined,
  ownershipNotes: string[] | undefined,
  emitter: ScanEmitter,
  pathResolver: ReturnType<typeof buildPathResolver>,
  investigation: InvestigationPhase | undefined,
  preUsage: { inputTokens: number; outputTokens: number },
): Promise<HeadlessResult> {
  const result = await runScan(
    {
      scanId,
      repoPath,
      analysisMode,
      dynamicMode,
      fileLimit: opts.fileLimit,
      buildCommand: opts.build,
      extraAllocators,
      extraDeallocators,
      ownershipNotes,
      enrich: opts.enrich,
      staticDiscovery: opts.staticDiscovery,
      staticTools: opts.staticTools,
    },
    {
      staticClient,
      dynamicClient,
      emitter,
      pathResolver,
      investigation,
      abortSignal: opts.signal,
      evalStaticPathMap: cfg.evalStaticPathMap,
      onUsageDelta: opts.onUsageDelta,
    },
  );

  // Sum logical MCP calls across both analyzer clients (the investigation phase
  // reuses these same instances, so the count covers discovery + investigation).
  const mcpCalls = staticClient.callCount + (dynamicClient?.callCount ?? 0);
  // Merge the pre-investigation profiler/strategist usage with the
  // investigation-phase ledger — both are real LLM cost for this scan.
  const usage = {
    inputTokens: (result.investigation?.usage?.inputTokens ?? 0) + preUsage.inputTokens,
    outputTokens: (result.investigation?.usage?.outputTokens ?? 0) + preUsage.outputTokens,
  };

  const formats = parseFormats(opts.format);
  const { files } = writeReports(
    dir,
    result.report,
    formats,
    result.investigation?.transcript as any,
    result.investigation?.stepsLog,
  );
  if (existsSync(join(dir, 'snapshot.json'))) {
    try {
      const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf-8'));
      writeScanMetrics(
        dir,
        computeScanMetrics(snap, {
          mode: opts.mode,
          dynamic: opts.dynamic,
          // Provenance only meaningful when the LLM actually drove the scan.
          ...(analysisMode === AnalysisMode.LLM_ASSISTED
            ? { provider: cfg.llm.provider, model: cfg.llm.model, temperature: cfg.llm.temperature, pricing: cfg.pricing }
            : {}),
          turns: result.investigation?.turns,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          durationMs: Date.now() - startedAt,
          mcpCalls,
        }),
      );
    } catch {
      /* metrics best-effort */
    }
  }

  if (!opts.quiet) {
    const s = result.report.summary;
    const bundles = result.report.bundles;
    const coverage = formatTally(tally(bundles.map((b) => b.dynamicCoverage || 'dynamic_off')));
    const judge = formatTally(tally(bundles.map((b) => b.verdict?.tool || 'none')));
    process.stdout.write(
      `\n✓ scan ${scanId} complete — ${s.totalCandidates} candidates, ` +
        `${s.confirmedLeaks} confirmed, ${s.likelyLeaks} likely. Reports in ${dir}\n` +
        `  coverage: ${coverage} · judge: ${judge}\n`,
    );
  }
  const truncatedCalls = result.investigation?.truncatedCalls ?? 0;
  return { ...result, scanId, dir, files, mcpCalls, usage, truncatedCalls };
}

/** Count occurrences of each value (for the coverage / judge-path distributions). */
function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
}
/** `k=n k=n …` sorted by count desc — a compact one-line distribution. */
function formatTally(t: Record<string, number>): string {
  const entries = Object.entries(t).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([k, n]) => `${k}=${n}`).join(' ') : 'none';
}

function parseFormats(spec: string): ReportFormatOpt[] {
  const allowed = new Set(['json', 'markdown', 'md', 'html', 'snapshot', 'csv']);
  return spec
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => allowed.has(s)) as ReportFormatOpt[];
}

function makeScanId(repoPath: string): string {
  const name = basename(repoPath).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.abs(hashString(repoPath + d.getTime())).toString(36).slice(0, 6);
  return `scan_${name}_${stamp}_${rand}`;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
