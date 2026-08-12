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
import { mapWithLimit, McpClient } from '@cleak/agent-core';
import type { AgentEvent } from '@cleak/agent-core';
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
  applyOwnershipCorrelations,
  type StaticContextStore,
} from '../domain/staticContext';
import { coerceToObject } from '../domain/mcpResult';
import type { PathResolver } from '../domain/pathResolver';
import { createScanCaches, type ScanCaches } from '../domain/scanCaches';
import type { InvestigationPhase, InvestigationOutcome, OrchestratorCommonDeps } from './investigation';

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

export type ScanDeps = {
  staticClient: McpClient;
  dynamicClient?: McpClient;
  emitter: ScanEmitter;
  /** The agentic investigation phase (M3). When absent, the scan is discovery + heuristic judge only. */
  investigation?: InvestigationPhase;
  now?: () => string;
  /** Config-level static enrichment default (replaces STATIC_ENRICH env var). */
  configStaticEnrich?: boolean;
  /** Eval-time path remapping (replaces EVAL_STATIC_PATH_MAP env var). */
  evalStaticPathMap?: string;
} & OrchestratorCommonDeps;

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
 * from the host; set `eval.staticPathMap` in config to remap (format: "from=to").
 * Unset (host-run analyzer) ⇒ identity (just absolutize). content-based tools
 * (functionSummary/pathConstraints) send file content inline and never use this.
 */
function analyzerPath(hostPath: string, pathMap?: string): string {
  const abs = resolvePath(hostPath);
  if (!pathMap) return abs;
  const eq = pathMap.indexOf('=');
  if (eq < 0) return abs;
  const from = pathMap.slice(0, eq);
  const to = pathMap.slice(eq + 1);
  return abs.startsWith(from) ? to + abs.slice(from.length) : abs;
}

/** Inverse of `analyzerPath` — maps a path the analyzer returned (e.g. a `callGraph`
 * callee's file) back to the host filesystem. Identity when `pathMap` is unset (the
 * host-run analyzer default). With `pathMap` set (Docker), this is a literal-prefix
 * inverse of the `from=to` substitution above — not yet verified against a real
 * path-mapped Docker run, unlike the unset-pathMap default used by Juliet/local runs. */
function hostPath(analyzerP: string, pathMap?: string): string {
  if (!pathMap) return analyzerP;
  const eq = pathMap.indexOf('=');
  if (eq < 0) return analyzerP;
  const from = pathMap.slice(0, eq);
  const to = pathMap.slice(eq + 1);
  return analyzerP.startsWith(to) ? from + analyzerP.slice(to.length) : analyzerP;
}

/**
 * MCP transport-level retry (`isTransientError` in `agent-core`) deliberately
 * EXCLUDES tool-level errors — a tool rejecting bad input shouldn't be retried
 * blindly. A request TIMEOUT (`-32001`) is different: it surfaces as a
 * tool-level error but is much more like a transient fault (the server was
 * momentarily overloaded), especially on a real project where hundreds of
 * candidates fire concurrent `functionSummary`/`pathConstraints` calls. One
 * bounded retry here — never for other tool errors, which stay a real signal.
 */
const TOOL_TIMEOUT_RE = /-32001|timed out/i;
export async function callToolRetryTimeout<T>(label: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!TOOL_TIMEOUT_RE.test(err instanceof Error ? err.message : String(err))) throw err;
    console.debug(`${label} timed out — retrying once`);
    return call();
  }
}

async function enrichStaticEvidence(
  bundles: LeakBundle[],
  staticClient: McpClient,
  input: ScanInput,
  abortSignal?: AbortSignal,
  evalStaticPathMap?: string,
  caches?: ScanCaches,
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
    ? walkCFiles(input.repoPath, input.fileLimit).map((f) => analyzerPath(f, evalStaticPathMap))
    : [];

  // ── Project-level Clang scan-build (opt-in): run ONCE over the whole build, then
  // attach its diagnostics to every matching candidate as a deterministic second
  // static opinion. Needs a build command (scan-build intercepts the real build),
  // like the dynamic recipe — so it's skipped when no buildCommand is available. ──
  if (tools.has('scanBuild') && input.buildCommand) {
    try {
      const run = coerceToObject(
        await staticClient.callTool('scanBuildRun', { projectPath: analyzerPath(input.repoPath, evalStaticPathMap), buildCommand: input.buildCommand }),
      );
      const runId = typeof run.runId === 'string' ? run.runId : undefined;
      if (runId) {
        const report = coerceToObject(await staticClient.callTool('scanBuildGetReport', { runId }));
        const findings = Array.isArray(report.findings) ? (report.findings as Array<Record<string, any>>) : [];
        attachScanBuildDiagnostics(bundles, findings);
      }
    } catch (err) {
      console.debug(`scan-build enrichment failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await mapWithLimit(bundles, THRESHOLDS.discoveryConcurrency, async (b) => {
    if (abortSignal?.aborted) return;
    const file = b.candidate.file_path;
    // P0-1: the per-scan file-content cache — the same candidate files were already
    // read during discovery, so enrichment must not re-read them from disk.
    const content = caches ? caches.files.read(file) : readFileSafe(file);
    if (content === null) return;
    const fn = b.candidate.function_name;
    const line = b.candidate.line_number;
    if (tools.has('functionSummary')) {
      try {
        const fsArgs = { filePath: file, content, functionName: fn, ...allocArgs };
        const fs = await callToolRetryTimeout('functionSummary', () => staticClient.callTool('functionSummary', fsArgs));
        foldStaticResult(store, 'functionSummary', { filePath: file, functionName: fn }, fs, [b]);
        // P0-2: cache the successful result keyed by (tool + args minus content) so a
        // Stage-A sub-agent asking the same question reuses it instead of re-invoking.
        caches?.tools.set('functionSummary', fsArgs, fs);
      } catch {
        console.debug(`functionSummary failed for ${file}:${fn}`);
      }
    }
    if (tools.has('pathConstraints')) {
      try {
        const pcArgs = { filePath: file, content, lineNumber: line, ...allocArgs };
        const pc = await callToolRetryTimeout('pathConstraints', () => staticClient.callTool('pathConstraints', pcArgs));
        foldStaticResult(store, 'pathConstraints', { filePath: file, lineNumber: line }, pc, [b]);
        caches?.tools.set('pathConstraints', pcArgs, pc);
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

// ── Preflight ──
async function runPreflight(staticClient: McpClient, emitter: ScanEmitter): Promise<void> {
  emitter.emit(ScanEventName.PREFLIGHT_STARTED, {});
  const staticUp = await staticClient.ping();
  if (!staticUp) {
    emitter.emit(ScanEventName.PREFLIGHT_FAILED, { reason: 'static analyzer unreachable' });
    throw new Error('Static analyzer MCP server is unreachable.');
  }
  emitter.emit(ScanEventName.PREFLIGHT_PASSED, {});
}

// ── Discovery (host-side): the orchestrator owns the workspace, so we walk the
// repo on the host and send each file's CONTENT to the stateless candidateScan
// tool. No shared filesystem with the analyzer — works the same whether the
// analyzer runs locally or on a remote host. ──
async function runDiscovery(
  input: ScanInput,
  deps: ScanDeps,
  candidates: CandidateManager,
  emitter: ScanEmitter,
  pathResolver: PathResolver,
  caches?: ScanCaches,
): Promise<{
  totalFiles: number;
  warning?: string;
  dynamicRanInDiscovery: boolean;
  /** Diagnostic counters for the static-discovery loop — permanent, cheap (counts
   * only, no per-file logging), and the one place today that can tell a "genuinely
   * empty file" apart from a silent drop. Undefined when static discovery didn't run
   * (dynamic-only ablation). See scanController.ts's `runDiscovery` doc comment. */
  filesReadFailed?: number;
  filesScanFailed?: number;
  filesZeroCandidates?: number;
}> {
  emitter.emit(ScanEventName.DISCOVERY_STARTED, { repoPath: input.repoPath });
  const staticDiscovery = input.staticDiscovery !== false;
  let totalFiles = 0;
  let warning: string | undefined;
  // True once the dynamic stage has already executed during discovery (static=false),
  // so the later dynamic stages don't build+run a second time.
  let dynamicRanInDiscovery = false;
  // Discovery accounting (static path only — see the doc comment on the return
  // type). Declared here, not inside the `if (staticDiscovery)` block, so they
  // flow through the single shared `return` at the end alongside `totalFiles`/
  // `warning` instead of needing an early return that would skip
  // DISCOVERY_FINISHED below.
  let filesReadFailed: number | undefined;
  let filesScanFailed: number | undefined;
  let filesZeroCandidates: number | undefined;

  if (staticDiscovery) {
    const cFiles = walkCFiles(input.repoPath, input.fileLimit && input.fileLimit > 0 ? input.fileLimit : 2000).filter(
      (f) => !JULIET_SUPPORT_FILES.has(basename(f).toLowerCase()),
    );
    totalFiles = cFiles.length;
    emitter.emit(ScanEventName.CANDIDATES_SCANNING, { totalFiles: cFiles.length });

    // Scan files concurrently (each candidateScan is an independent, stateless MCP
    // call) — the sequential per-file round-trips were the discovery bottleneck.
    //
    // Each of the N concurrent workers gets its OWN McpClient — NOT a shared one.
    // `McpClient` memoizes a single underlying transport connection, and its retry
    // path calls `close()` on that shared connection when ANY in-flight call hits a
    // transient error. With one client shared across `discoveryConcurrency` workers,
    // one bad file (e.g. a 46K-line generated test file) closing the connection took
    // every OTHER concurrently in-flight file down with it — including trivial ones
    // (a 12-line file failed alongside it) — silently losing their candidates and
    // skewing recall. Dedicated per-worker clients isolate that blast radius to the
    // worker that actually hit the fault.
    const poolSize = Math.min(Math.max(1, THRESHOLDS.discoveryConcurrency), cFiles.length || 1);
    const workerClients = Array.from(
      { length: poolSize },
      (_, i) => new McpClient(deps.staticClient.endpoint, `static-discovery-${i}`),
    );
    const scanned = new Array<any>(cFiles.length);
    let nextIdx = 0;
    // Local, definitely-assigned counters for the closures below — TS can't narrow
    // the outer `number | undefined` fields across an async closure, so count here
    // and copy into the return-shaped variables once discovery finishes.
    let readFailedCount = 0;
    let scanFailedCount = 0;
    const scanWorker = async (client: McpClient) => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= cFiles.length) return;
        if (deps.abortSignal?.aborted) return;
        const file = cFiles[idx];
        // P0-1: first read of each file lands in the per-scan cache; later readers
        // (enrichment, sub-agents, judge) get the memoized content.
        const content = caches ? caches.files.read(file) : readFileSafe(file);
        if (content === null) {
          readFailedCount++;
          continue;
        }
        try {
          scanned[idx] = (await client.callTool(
            'candidateScan',
            {
              filePath: file,
              content,
              ...(input.extraAllocators?.length ? { extraAllocators: input.extraAllocators } : {}),
              ...(input.extraDeallocators?.length ? { extraDeallocators: input.extraDeallocators } : {}),
            },
            // Default 60s is tuned for Juliet's small single-function files; real-world
            // sources can run tens of thousands of lines (e.g. libxml2's testapi.c,
            // 46K lines) and legitimately need longer to parse.
            { timeoutMs: 180_000 },
          )) as any;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`candidateScan failed for ${file}: ${msg}`, err instanceof Error ? err.stack : undefined);
          scanned[idx] = null;
          scanFailedCount++;
        }
      }
    };
    try {
      await Promise.all(workerClients.map(scanWorker));
    } finally {
      await Promise.all(workerClients.map((c) => c.close()));
    }
    // Ingest IN FILE ORDER (scanned[] is indexed by cFiles position, not completion
    // order) so the candidate set and its ordering stay deterministic.
    let zeroCandidatesCount = 0;
    let rawCandidatesSeen = 0;
    scanned.forEach((cs, i) => {
      if (!cs) return;
      const file = cFiles[i];
      const fileCandidates = cs.candidates || [];
      if (fileCandidates.length === 0) zeroCandidatesCount++;
      rawCandidatesSeen += fileCandidates.length;
      for (const c of fileCandidates) {
        // file_path is the real host path (identity) — the host reads it for
        // snippets/diffs and content is sent to the analyzers.
        candidates.ingest(normalizeCandidate({ ...c, filePath: c.filePath || c.file_path || file }, (p) => p));
      }
    });
    filesReadFailed = readFailedCount;
    filesScanFailed = scanFailedCount;
    filesZeroCandidates = zeroCandidatesCount;
    // Always-on discovery accounting — the one place today that can tell "this file
    // genuinely has no allocations" apart from a silent per-file drop (an MCP
    // response that comes back neither an error nor containing `candidates`, or a
    // host-side read failure). Cheap (counts only) and unconditional, unlike the
    // per-file `candidateScan failed` log above which only fires on a thrown error.
    // `rawCandidatesSeen` vs the final ingested-bundle count also catches silent
    // de-dup/collision inside `CandidateManager.ingest` (a Map keyed by bundleId) —
    // if they diverge, candidates are being collapsed AFTER a successful scan, not
    // lost during discovery itself.
    console.error(
      `discovery: ${cFiles.length} files walked · ${filesReadFailed} read-failed · ` +
        `${filesScanFailed} scan-failed · ${filesZeroCandidates} zero-candidate · ` +
        `${rawCandidatesSeen} raw candidates seen · ${candidates.getAllBundles().length} candidates ingested`,
    );

    // Cross-function/cross-file ownership correlation (Juliet flow-variant ≥21 fix):
    // exonerate a candidate whose allocation is freed via a callee in a DIFFERENT
    // file, and synthesize a candidate at a sink parameter that's never freed on
    // ANY path — neither is reachable from the per-file candidateScan/F3 mechanism
    // above. Unconditional (no --enrich/--static-tools gate) so no_llm and
    // llm_assisted see the same corrected candidate set. Best-effort: a correlation
    // failure must never abort discovery, same as every other tool call here.
    if (cFiles.length > 0) {
      try {
        const cgResult = await deps.staticClient.callTool(
          'callGraph',
          {
            rootPath: analyzerPath(input.repoPath, deps.evalStaticPathMap),
            files: cFiles.map((f) => analyzerPath(f, deps.evalStaticPathMap)),
            ...(input.extraAllocators?.length ? { extraAllocators: input.extraAllocators } : {}),
            ...(input.extraDeallocators?.length ? { extraDeallocators: input.extraDeallocators } : {}),
          },
          { timeoutMs: 180_000 },
        );
        applyOwnershipCorrelations(candidates, cgResult, (p) => hostPath(p, deps.evalStaticPathMap));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`ownership correlation (callGraph) failed: ${msg}`);
      }
    }
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

  return { totalFiles, warning, dynamicRanInDiscovery, filesReadFailed, filesScanFailed, filesZeroCandidates };
}

// ── Deterministic static enrichment: populate each bundle's staticEvidence so the
// heuristic judge is path-aware (alloc→free pairing + feasible leak paths), even in
// no_llm. OPT-IN (STATIC_ENRICH=on) — the underlying exit-path analysis is a
// heuristic CFG (guard-subset free reconciliation; no SMT path-feasibility), so it
// over-reports unreconciled exits and tanks precision on the easy Juliet corpus
// (FP 7→44). It is the right base for HARD real-project corpora (where the leak IS
// path-sensitive), but must stay off by default so the reproducible Juliet baseline
// is preserved. ──
// Enrichment needs static candidates; skip it entirely for dynamic-only discovery.
async function runEnrichment(
  discovered: number,
  staticDiscovery: boolean,
  bundles: LeakBundle[],
  staticClient: McpClient,
  input: ScanInput,
  abortSignal?: AbortSignal,
  configStaticEnrich?: boolean,
  evalStaticPathMap?: string,
  caches?: ScanCaches,
): Promise<void> {
  const enrichOn = staticDiscovery && (input.enrich ?? configStaticEnrich === true);
  if (discovered > 0 && enrichOn) {
    await enrichStaticEvidence(bundles, staticClient, input, abortSignal, evalStaticPathMap, caches);
  }
}

// ── Investigation (agentic; optional in M2) ──
async function runInvestigation(
  deps: ScanDeps,
  input: ScanInput,
  candidates: CandidateManager,
  dynamicRanInDiscovery: boolean,
  caches?: ScanCaches,
): Promise<InvestigationOutcome | undefined> {
  let investigationOutcome: InvestigationOutcome | undefined;
  if (deps.investigation && input.analysisMode === AnalysisMode.LLM_ASSISTED) {
    investigationOutcome = await deps.investigation.run(candidates, {
      repoPath: input.repoPath,
      buildCommand: input.buildCommand,
      projectOwnershipNotes: input.ownershipNotes,
      emitter: deps.emitter,
      staticClient: deps.staticClient,
      dynamicClient: deps.dynamicClient,
      pathResolver: deps.pathResolver,
      abortSignal: deps.abortSignal,
      getSteering: deps.getSteering,
      awaitResume: deps.awaitResume,
      onAgentEvent: deps.onAgentEvent,
      onModelActivity: deps.onModelActivity,
      requestPermission: deps.requestPermission,
      onUsageDelta: deps.onUsageDelta,
      // static=false: the dynamic stage already ran during discovery — the
      // investigation must not build+run a second time (and must keep that coverage).
      dynamicAlreadyRan: dynamicRanInDiscovery,
      // P0-1/P0-2: share the scan's memo caches so the agentic phase reuses evidence
      // the deterministic phases already gathered (and reads files once per scan).
      caches,
    });
  }
  return investigationOutcome;
}

// ── Deterministic dynamic stage (no_llm only): build → LSan with NO LLM, so the
// `--dynamic` flag is meaningful in the static mode and the heuristic judge can use
// runtime evidence (enables a clean 2×2 ablation: static / +dynamic / +LLM / full).
// llm_assisted runs dynamic INSIDE the investigation above, so this is no_llm-exclusive.
// SECURITY: this EXECUTES code (build + run the target) under the same confinement as
// llm_assisted+dynamic; gated on a known buildCommand so default no_llm stays static-only,
// and on dynamicMode!==OFF so `--dynamic off` leaves the reproducible baseline byte-identical. ──
async function runDynamicStage(
  input: ScanInput,
  deps: ScanDeps,
  candidates: CandidateManager,
  pathResolver: PathResolver,
  dynamicRanInDiscovery: boolean,
  emitter: ScanEmitter,
): Promise<void> {
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
}

// ── Judging: deterministic heuristic finalizer for any un-verdicted bundle ──
async function runJudging(
  emitter: ScanEmitter,
  bundles: LeakBundle[],
  investigationOutcome?: InvestigationOutcome,
): Promise<void> {
  emitter.emit(ScanEventName.JUDGING_STARTED, {});
  for (const bundle of bundles) {
    if (bundle.verdict) continue;
    bundle.verdict = heuristicVerdict(bundle, investigationOutcome?.staticContext?.[bundle.bundleId] ?? {});
  }
  emitter.emit(ScanEventName.JUDGING_FINISHED, {});
}

// ── Reporting ──
async function runReporting(
  emitter: ScanEmitter,
  candidates: CandidateManager,
  investigationOutcome: InvestigationOutcome | undefined,
  input: ScanInput,
  startedAt: string,
  now: () => string,
): Promise<{report: ScanReport & Record<string, unknown>; bundles: LeakBundle[]; investigation: InvestigationOutcome | undefined}> {
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

export async function runScan(input: ScanInput, deps: ScanDeps): Promise<ScanResult> {
  const { emitter, staticClient, pathResolver } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const candidates = new CandidateManager(now);
  // Per-scan memoization (P0-1 file content + P0-2 tool results). Created HERE, per
  // scan, and dropped when runScan returns — nothing module-level persists, so no
  // cached file content or tool result can ever leak into a later scan.
  const caches = createScanCaches();

  emitter.emit(ScanEventName.SCAN_CREATED, { scanId: input.scanId, repoPath: input.repoPath, mode: input.analysisMode });

  await runPreflight(staticClient, emitter);

  // ── Workspace (host paths; no materialization in the standalone runner) ──
  emitter.emit(ScanEventName.WORKSPACE_STARTED, { repoPath: input.repoPath });
  if (input.buildCommand) emitter.emit(ScanEventName.BUILD_PLAN_SELECTED, { buildCommand: input.buildCommand });
  emitter.emit(ScanEventName.WORKSPACE_FINISHED, {});

  const { totalFiles, warning, dynamicRanInDiscovery } = await runDiscovery(input, deps, candidates, emitter, pathResolver, caches);

  const discovered = candidates.getAllBundles().length;
  const staticDiscovery = input.staticDiscovery !== false;
  // P0-3: the deterministic dynamic stage (no_llm recipe: buildTarget → lsanRun) and
  // the deterministic static enrichment are INDEPENDENT (they fold evidence into
  // different bundle fields: staticEvidence vs evidence/dynamicCoverage) — start them
  // concurrently instead of serially. Each is a no-op when its gate is off (dynamic
  // needs buildCommand + no_llm; enrichment needs the enrich flag), so the default
  // sequential-equivalent paths are unchanged. Investigation (llm_assisted) still
  // runs AFTER both, exactly as before.
  const enrichmentPromise = runEnrichment(discovered, staticDiscovery, candidates.getAllBundles(), staticClient, input, deps.abortSignal, deps.configStaticEnrich, deps.evalStaticPathMap, caches);
  const dynamicPromise = runDynamicStage(input, deps, candidates, pathResolver, dynamicRanInDiscovery, emitter);
  await Promise.all([enrichmentPromise, dynamicPromise]);

  const investigationOutcome = await runInvestigation(deps, input, candidates, dynamicRanInDiscovery, caches);
  await runJudging(emitter, candidates.getAllBundles(), investigationOutcome);
  const { report, bundles, investigation } = await runReporting(emitter, candidates, investigationOutcome, input, startedAt, now);

  return { report, bundles, investigation };
}
