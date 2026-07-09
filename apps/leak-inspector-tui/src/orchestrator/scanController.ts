/**
 * The HYBRID scan controller — the single core both the headless runner and the
 * interactive TUI drive:
 *
 *   discovery (deterministic: index + candidate scan)
 *     → investigation (agentic native tool-calling loop; M3)
 *     → judging (deterministic heuristic finalizer for un-verdicted bundles)
 *     → reporting
 *
 * Deterministic discovery + judging keep the candidate set and verdict synthesis
 * reproducible (so reports are comparable across runs); the investigation phase
 * is where the model freely chooses which analysis tools to run.
 */

import { basename, resolve as resolvePath } from 'node:path';
import { mapWithLimit } from '@cleak/agent-core';
import type { AgentEvent, McpClient } from '@cleak/agent-core';
import {
  AnalysisMode,
  DynamicMode,
  ScanStatus,
  type LeakBundle,
  type ScanMetadata,
  type ScanReport,
} from '@cleak/common/types';
import { LeakReporting } from '@cleak/common/analysis/reporting';
import { ScanEmitter, ScanEventName } from './events';
import { CandidateManager, normalizeCandidate } from '../domain/candidateState';
import { PathResolver } from '../domain/pathResolver';
import { walkCFiles, readFileSafe } from '../domain/fileWalk';
import { runDeterministicDynamicStage, reconcileDynamicEvidence, computeDynamicCoverage } from '../domain/dynamicEvidence';
import { runDynamicOnlyDiscovery } from '../domain/dynamicDiscovery';
import { heuristicVerdict } from '../domain/judge';
import { THRESHOLDS } from '../domain/thresholds';
import {
  foldStaticResult,
  attachScanBuildDiagnostics,
  interproceduralLeakPaths,
  appendFeasibleLeakPaths,
  type StaticContextStore,
} from '../domain/staticContext';
import { coerceToObject } from '../domain/mcpResult';
import type { InvestigationPhase, InvestigationOutcome } from './investigation';

const reporter = new LeakReporting();

/**
 * Juliet's shared test-harness files. The buildable-project ingest copies these
 * into each case dir so testcases compile, but they are NOT testcase code —
 * scanning them only produces noise candidates (e.g. `unknown@std_testcase.h`)
 * that waste tokens and confuse the judge. Skip them at discovery.
 */
const JULIET_SUPPORT_FILES = new Set([
  'std_testcase.h',
  'std_testcase_io.h',
  'std_testcase.cpp',
  'io.c',
  'main.cpp',
]);

export interface ScanInput {
  scanId: string;
  repoPath: string;
  analysisMode: AnalysisMode;
  dynamicMode: DynamicMode;
  fileLimit?: number;
  buildCommand?: string;
  /** Per-project factory allocators / custom deallocators (≈ LAMeD AllocSource /
   * FreeSink) passed to candidateScan so wrapper-named allocators (cJSON_Duplicate,
   * xmlNewNode, …) are discovered. Usually supplied by the corpus manifest. */
  extraAllocators?: string[];
  extraDeallocators?: string[];
  /** Project ownership conventions (LLM-discovered) forwarded to the LLM judge. */
  ownershipNotes?: string[];
  /** Deterministic static enrichment (alloc→free pairing + feasible leak paths).
   * Explicit override of the `STATIC_ENRICH=on` env gate — lets the baseline sweep
   * control it per-run without racing on a global env var. */
  enrich?: boolean;
  /** Static candidate discovery (candidateScan). Default true. When false
   * (ablation `static=false`), discovery is dynamic-only: build + run under LSan and
   * synthesize one candidate per runtime leak site (no static scan). Needs a build command. */
  staticDiscovery?: boolean;
  /** Which static EVIDENCE tools the enrichment stage runs (tool-level ablation).
   * Default = the wired, judge-consumed pair `['functionSummary','pathConstraints']`.
   * An empty list ⇒ enrich gathers no evidence (candidateScan-only static). */
  staticTools?: string[];
}

export interface ScanDeps {
  staticClient: McpClient;
  dynamicClient?: McpClient;
  emitter: ScanEmitter;
  pathResolver: PathResolver;
  /** The agentic investigation phase (M3). When absent, the scan is discovery + heuristic judge only. */
  investigation?: InvestigationPhase;
  /** Optional raw agent-event sink for rich UI rendering (TUI); `agent` tags the source sub-agent. */
  onAgentEvent?: (ev: AgentEvent, agent?: import('./investigation').AgentMeta) => void;
  /** Optional model I/O cue ('send'/'receive') for the send/receive UI arrow. */
  onModelActivity?: (dir: 'send' | 'receive') => void;
  /** Optional interactive permission resolver (TUI). */
  requestPermission?: (req: { id: string; name: string; input: unknown }) => Promise<'allow' | 'deny'>;
  /** Abort signal to interrupt discovery + the agentic loop (e.g. ESC in the TUI). */
  abortSignal?: AbortSignal;
  /** Drained each agent turn — lets the user steer the agent mid-run. */
  getSteering?: () => string[];
  /** Called when the model fails — resume (user typed continue/guidance) or abort. */
  awaitResume?: (reason: string) => Promise<'resume' | 'abort'>;
  now?: () => string;
}

export interface ScanResult {
  report: ScanReport & Record<string, unknown>;
  bundles: LeakBundle[];
  investigation?: InvestigationOutcome;
}

/**
 * Deterministic static enrichment: for each candidate, run the analyzer's
 * `functionSummary` + `pathConstraints` (WITH the per-project allocators) and fold
 * the results into `bundle.staticEvidence` (alloc→free pairing, feasible leak paths).
 * This makes the heuristic judge PATH-AWARE even in `no_llm` — previously it judged
 * on an empty static context there — and supplies the project's factory allocators
 * to the static analysis, which the llm_assisted sub-agents otherwise omit. Pure
 * (Tier-1 deterministic): the same content + allocators always yield the same evidence.
 */
/**
 * Map a host path into the ANALYZER's filesystem for server-side-file tools
 * (interproceduralFlow, scanBuild). When the analyzer runs in Docker its paths differ
 * from the host; set `EVAL_STATIC_PATH_MAP=/host/prefix=/container/prefix` to remap.
 * Unset (host-run analyzer) ⇒ identity (just absolutize). content-based tools
 * (functionSummary/pathConstraints) send file content inline and never use this.
 */
function analyzerPath(hostPath: string): string {
  const abs = resolvePath(hostPath);
  const map = process.env.EVAL_STATIC_PATH_MAP;
  if (!map) return abs;
  const eq = map.indexOf('=');
  if (eq < 0) return abs;
  const from = map.slice(0, eq);
  const to = map.slice(eq + 1);
  return abs.startsWith(from) ? to + abs.slice(from.length) : abs;
}

async function enrichStaticEvidence(
  bundles: LeakBundle[],
  staticClient: McpClient,
  input: ScanInput,
  abortSignal?: AbortSignal,
): Promise<void> {
  const allocArgs = {
    ...(input.extraAllocators?.length ? { extraAllocators: input.extraAllocators } : {}),
    ...(input.extraDeallocators?.length ? { extraDeallocators: input.extraDeallocators } : {}),
  };
  // Tool-level ablation: which evidence tools the enrich stage runs. Default = the
  // wired, judge-consumed pair (functionSummary + pathConstraints). Opt-in extras
  // (`scanBuild`, `interproceduralFlow`) only run when named in `--static-tools`, so
  // the default 2-tool baseline stays byte-identical. (callGraph: still unused.)
  const tools = new Set(input.staticTools ?? ['functionSummary', 'pathConstraints']);
  const store: StaticContextStore = new Map();

  // interproceduralFlow (opt-in, B2) reads files SERVER-SIDE and traces callees ACROSS
  // files, so it needs the WHOLE repo's .c/.h set — not just the candidates' files, or
  // callees in sibling files are invisible (recall capped at the candidate file boundary,
  // which neutered it on multi-file real projects). Walk the repo once + remap to the
  // analyzer's filesystem. Bounded by fileLimit (walkCFiles default 2000).
  const ipFiles = tools.has('interproceduralFlow')
    ? walkCFiles(input.repoPath, input.fileLimit).map(analyzerPath)
    : [];

  // ── Project-level Clang scan-build (opt-in): run ONCE over the whole build, then
  // attach its diagnostics to every matching candidate as a deterministic second
  // static opinion. Needs a build command (scan-build intercepts the real build),
  // like the dynamic recipe — so it's skipped when no buildCommand is available. ──
  if (tools.has('scanBuild') && input.buildCommand) {
    try {
      const run = coerceToObject(
        await staticClient.callTool('scanBuildRun', { projectPath: analyzerPath(input.repoPath), buildCommand: input.buildCommand }),
      );
      const runId = typeof run.runId === 'string' ? run.runId : undefined;
      if (runId) {
        const report = coerceToObject(await staticClient.callTool('scanBuildGetReport', { runId }));
        const findings = Array.isArray(report.findings) ? (report.findings as Array<Record<string, any>>) : [];
        attachScanBuildDiagnostics(bundles, findings);
      }
    } catch (err) {
      console.debug(`scan-build enrichment failed: ${err?.message}`);
    }
  }

  await mapWithLimit(bundles, THRESHOLDS.discoveryConcurrency, async (b) => {
    if (abortSignal?.aborted) return;
    const file = b.candidate.file_path;
    const content = readFileSafe(file);
    if (content === null) return;
    const fn = b.candidate.function_name;
    const line = b.candidate.line_number;
    if (tools.has('functionSummary')) {
      try {
        const fs = await staticClient.callTool('functionSummary', { filePath: file, content, functionName: fn, ...allocArgs });
        foldStaticResult(store, 'functionSummary', { filePath: file, functionName: fn }, fs, [b]);
      } catch {
        console.debug(`functionSummary failed for ${file}:${fn}`);
      }
    }
    if (tools.has('pathConstraints')) {
      try {
        const pc = await staticClient.callTool('pathConstraints', { filePath: file, content, lineNumber: line, ...allocArgs });
        foldStaticResult(store, 'pathConstraints', { filePath: file, lineNumber: line }, pc, [b]);
      } catch {
        console.debug(`pathConstraints failed for ${file}:${line}`);
      }
    }
    // ── interproceduralFlow (opt-in, B2): RECALL-direction only. Trace callees from the
    // candidate's function; if it allocates without a free reachable across the boundary,
    // append a feasible leak path (additive — never exonerates). Runs AFTER pathConstraints
    // so its paths concat onto, not clobber, the path-constraint evidence. ──
    if (tools.has('interproceduralFlow') && fn) {
      try {
        const ip = await staticClient.callTool('interproceduralFlow', { rootPath: input.repoPath, functionName: fn, files: ipFiles, ...allocArgs });
        appendFeasibleLeakPaths(b, interproceduralLeakPaths(ip, { function_name: fn, line_number: line }));
      } catch {
        console.debug(`interproceduralFlow failed for ${fn}`);
      }
    }
  });
}

export async function runScan(input: ScanInput, deps: ScanDeps): Promise<ScanResult> {
  const { emitter, staticClient, pathResolver } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const candidates = new CandidateManager(now);

  emitter.emit(ScanEventName.SCAN_CREATED, { scanId: input.scanId, repoPath: input.repoPath, mode: input.analysisMode });

  // ── Preflight ──
  emitter.emit(ScanEventName.PREFLIGHT_STARTED, {});
  const staticUp = await staticClient.ping();
  if (!staticUp) {
    emitter.emit(ScanEventName.PREFLIGHT_FAILED, { reason: 'static analyzer unreachable' });
    throw new Error('Static analyzer MCP server is unreachable.');
  }
  emitter.emit(ScanEventName.PREFLIGHT_PASSED, {});

  // ── Workspace (host paths; no materialization in the standalone runner) ──
  emitter.emit(ScanEventName.WORKSPACE_STARTED, { repoPath: input.repoPath });
  if (input.buildCommand) emitter.emit(ScanEventName.BUILD_PLAN_SELECTED, { buildCommand: input.buildCommand });
  emitter.emit(ScanEventName.WORKSPACE_FINISHED, {});

  // ── Discovery (host-side): the orchestrator owns the workspace, so we walk the
  // repo on the host and send each file's CONTENT to the stateless candidateScan
  // tool. No shared filesystem with the analyzer — works the same whether the
  // analyzer runs locally or on a remote host. ──
  emitter.emit(ScanEventName.DISCOVERY_STARTED, { repoPath: input.repoPath });
  const staticDiscovery = input.staticDiscovery !== false;
  let totalFiles = 0;
  let warning: string | undefined;
  // True once the dynamic stage has already executed during discovery (static=false),
  // so the later dynamic stages don't build+run a second time.
  let dynamicRanInDiscovery = false;

  if (staticDiscovery) {
    const cFiles = walkCFiles(input.repoPath, input.fileLimit && input.fileLimit > 0 ? input.fileLimit : 2000).filter(
      (f) => !JULIET_SUPPORT_FILES.has(basename(f).toLowerCase()),
    );
    totalFiles = cFiles.length;
    emitter.emit(ScanEventName.CANDIDATES_SCANNING, { totalFiles: cFiles.length });

    // Scan files concurrently (each candidateScan is an independent, stateless MCP
    // call) — the sequential per-file round-trips were the discovery bottleneck.
    const scanned = await mapWithLimit(cFiles, THRESHOLDS.discoveryConcurrency, async (file) => {
      if (deps.abortSignal?.aborted) return null;
      const content = readFileSafe(file);
      if (content === null) return null;
      try {
        return (await staticClient.callTool('candidateScan', {
          filePath: file,
          content,
          ...(input.extraAllocators?.length ? { extraAllocators: input.extraAllocators } : {}),
          ...(input.extraDeallocators?.length ? { extraDeallocators: input.extraDeallocators } : {}),
        })) as any;
      } catch {
        console.debug(`candidateScan failed for ${file}`);
        return null;
      }
    });
    // Ingest IN FILE ORDER (mapWithLimit preserves input order) so the candidate set
    // and its ordering stay deterministic regardless of completion order.
    scanned.forEach((cs, i) => {
      if (!cs) return;
      const file = cFiles[i];
      for (const c of cs.candidates || []) {
        // file_path is the real host path (identity) — the host reads it for
        // snippets/diffs and content is sent to the analyzers.
        candidates.ingest(normalizeCandidate({ ...c, filePath: c.filePath || c.file_path || file }, (p) => p));
      }
    });
    if (candidates.getAllBundles().length === 0) {
      warning =
        cFiles.length === 0
          ? `No C/C++ source files found under "${input.repoPath}".`
          : `Scanned ${cFiles.length} file(s) but found no allocation candidates.`;
    }
  } else {
    // ── Dynamic-only discovery (ablation static=false): build + run under LSan and
    // synthesize one candidate per runtime leak site — no static candidateScan. ──
    if (deps.dynamicClient && input.buildCommand && input.dynamicMode !== DynamicMode.OFF) {
      emitter.emit(ScanEventName.DYNAMIC_STARTED, {});
      const onNotice = (text: string) => deps.onAgentEvent?.({ type: 'notice', text } as AgentEvent, undefined);
      const { store, candidates: dynCands, ran } = await runDynamicOnlyDiscovery(deps.dynamicClient, {
        repoPath: input.repoPath,
        buildCommand: input.buildCommand,
        pathResolver,
        abortSignal: deps.abortSignal,
        onNotice,
      });
      for (const c of dynCands) candidates.ingest(c);
      // Attach the LSan findings as evidence to the just-synthesized bundles + stamp coverage.
      reconcileDynamicEvidence(store, candidates.getAllBundles(), pathResolver);
      for (const b of candidates.getAllBundles()) b.dynamicCoverage = computeDynamicCoverage(store, b, true);
      dynamicRanInDiscovery = ran;
      emitter.emit(ScanEventName.DYNAMIC_FINISHED, { ran });
      if (candidates.getAllBundles().length === 0) {
        warning = ran
          ? 'Dynamic-only discovery: the target ran clean under LSan (no leaks observed).'
          : 'Dynamic-only discovery: could not build/run the target — no candidates.';
      }
    } else {
      warning = 'Dynamic-only discovery (static=false) needs the dynamic analyzer + a buildCommand + --dynamic != off.';
    }
  }

  const discovered = candidates.getAllBundles().length;
  emitter.emit(ScanEventName.DISCOVERY_FINISHED, {
    totalCandidates: discovered,
    totalFiles,
    ...(warning ? { warning } : {}),
  });

  // ── Deterministic static enrichment: populate each bundle's staticEvidence so the
  // heuristic judge is path-aware (alloc→free pairing + feasible leak paths), even in
  // no_llm. OPT-IN (STATIC_ENRICH=on) — the underlying exit-path analysis is a
  // heuristic CFG (guard-subset free reconciliation; no SMT path-feasibility), so it
  // over-reports unreconciled exits and tanks precision on the easy Juliet corpus
  // (FP 7→44). It is the right base for HARD real-project corpora (where the leak IS
  // path-sensitive), but must stay off by default so the reproducible Juliet baseline
  // is preserved. ──
  // Enrichment needs static candidates; skip it entirely for dynamic-only discovery.
  const enrichOn = staticDiscovery && (input.enrich ?? process.env.STATIC_ENRICH === 'on');
  if (discovered > 0 && enrichOn) {
    await enrichStaticEvidence(candidates.getAllBundles(), staticClient, input, deps.abortSignal);
  }

  // ── Investigation (agentic; optional in M2) ──
  let investigationOutcome: InvestigationOutcome | undefined;
  if (deps.investigation && input.analysisMode === AnalysisMode.LLM_ASSISTED) {
    investigationOutcome = await deps.investigation.run(candidates, {
      repoPath: input.repoPath,
      buildCommand: input.buildCommand,
      projectOwnershipNotes: input.ownershipNotes,
      emitter,
      staticClient,
      dynamicClient: deps.dynamicClient,
      pathResolver,
      abortSignal: deps.abortSignal,
      getSteering: deps.getSteering,
      awaitResume: deps.awaitResume,
      onAgentEvent: deps.onAgentEvent,
      onModelActivity: deps.onModelActivity,
      requestPermission: deps.requestPermission,
      // static=false: the dynamic stage already ran during discovery — the
      // investigation must not build+run a second time (and must keep that coverage).
      dynamicAlreadyRan: dynamicRanInDiscovery,
    });
  }

  // ── Deterministic dynamic stage (no_llm only): build → LSan with NO LLM, so the
  // `--dynamic` flag is meaningful in the static mode and the heuristic judge can use
  // runtime evidence (enables a clean 2×2 ablation: static / +dynamic / +LLM / full).
  // llm_assisted runs dynamic INSIDE the investigation above, so this is no_llm-exclusive.
  // SECURITY: this EXECUTES code (build + run the target) under the same confinement as
  // llm_assisted+dynamic; gated on a known buildCommand so default no_llm stays static-only,
  // and on dynamicMode!==OFF so `--dynamic off` leaves the reproducible baseline byte-identical. ──
  if (
    input.analysisMode === AnalysisMode.NO_LLM &&
    input.dynamicMode !== DynamicMode.OFF &&
    deps.dynamicClient &&
    input.buildCommand &&
    !dynamicRanInDiscovery // dynamic-only discovery already built+ran the target
  ) {
    emitter.emit(ScanEventName.DYNAMIC_STARTED, {});
    const onNotice = (text: string) => deps.onAgentEvent?.({ type: 'notice', text } as AgentEvent, undefined);
    const { ran } = await runDeterministicDynamicStage(deps.dynamicClient, candidates.getAllBundles(), {
      repoPath: input.repoPath,
      buildCommand: input.buildCommand,
      pathResolver,
      abortSignal: deps.abortSignal,
      onNotice,
    });
    emitter.emit(ScanEventName.DYNAMIC_FINISHED, { ran });
  } else if (input.analysisMode === AnalysisMode.NO_LLM && input.dynamicMode !== DynamicMode.OFF && !input.buildCommand) {
    deps.onAgentEvent?.(
      { type: 'notice', text: 'dynamic requested but no buildCommand — no_llm dynamic needs a build command; skipped' } as AgentEvent,
      undefined,
    );
  }

  // ── Judging: deterministic heuristic finalizer for any un-verdicted bundle ──
  emitter.emit(ScanEventName.JUDGING_STARTED, {});
  for (const bundle of candidates.getAllBundles()) {
    if (bundle.verdict) continue;
    bundle.verdict = heuristicVerdict(bundle, investigationOutcome?.staticContext?.[bundle.bundleId] ?? {});
  }
  emitter.emit(ScanEventName.JUDGING_FINISHED, {});

  // ── Reporting ──
  emitter.emit(ScanEventName.REPORTING_STARTED, {});
  const completedAt = now();
  const metadata: ScanMetadata = {
    scanId: input.scanId,
    workspacePath: input.repoPath,
    sourceWorkspacePath: input.repoPath,
    analysisMode: input.analysisMode,
    dynamicMode: input.dynamicMode,
    fileLimit: input.fileLimit ?? 0,
    buildCommand: input.buildCommand,
    startedAt,
    completedAt,
    status: ScanStatus.COMPLETED,
  };
  const bundles = candidates.getAllBundles();
  const report = reporter.buildReport(bundles, metadata, {
    ...(investigationOutcome?.agentDecisions ? { agentDecisions: investigationOutcome.agentDecisions } : {}),
  });
  emitter.emit(ScanEventName.REPORTING_FINISHED, {
    confirmed: report.summary.confirmedLeaks,
    likely: report.summary.likelyLeaks,
  });

  emitter.emit(ScanEventName.COMPLETED, {
    candidates: bundles.length,
    confirmed: report.summary.confirmedLeaks,
    likely: report.summary.likelyLeaks,
  });

  return { report, bundles, investigation: investigationOutcome };
}
