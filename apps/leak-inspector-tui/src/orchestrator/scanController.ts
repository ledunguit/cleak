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

import { basename } from 'node:path';
import { mapWithLimit } from '@mcpvul/agent-core';
import type { AgentEvent, McpClient } from '@mcpvul/agent-core';
import {
  AnalysisMode,
  DynamicMode,
  ScanStatus,
  type LeakBundle,
  type ScanMetadata,
  type ScanReport,
} from '@mcpvul/common/types';
import { LeakReporting } from '@mcpvul/common/analysis/reporting';
import { ScanEmitter, ScanEventName } from './events';
import { CandidateManager, normalizeCandidate } from '../domain/candidateState';
import { PathResolver } from '../domain/pathResolver';
import { walkCFiles, readFileSafe } from '../domain/fileWalk';
import { heuristicVerdict } from '../domain/judge';
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
  const cFiles = walkCFiles(input.repoPath, input.fileLimit && input.fileLimit > 0 ? input.fileLimit : 2000).filter(
    (f) => !JULIET_SUPPORT_FILES.has(basename(f).toLowerCase()),
  );
  emitter.emit(ScanEventName.CANDIDATES_SCANNING, { totalFiles: cFiles.length });

  // Scan files concurrently (each candidateScan is an independent, stateless MCP
  // call) — the sequential per-file round-trips were the discovery bottleneck.
  const DISCOVERY_CONCURRENCY = Math.max(1, Number(process.env.DISCOVERY_CONCURRENCY ?? 8));
  const scanned = await mapWithLimit(cFiles, DISCOVERY_CONCURRENCY, async (file) => {
    if (deps.abortSignal?.aborted) return null;
    const content = readFileSafe(file);
    if (content === null) return null;
    try {
      return (await staticClient.callTool('candidateScan', { filePath: file, content })) as any;
    } catch {
      return null; // a single unreadable/odd file shouldn't abort discovery
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

  const discovered = candidates.getAllBundles().length;
  const warning =
    discovered === 0
      ? cFiles.length === 0
        ? `No C/C++ source files found under "${input.repoPath}".`
        : `Scanned ${cFiles.length} file(s) but found no allocation candidates.`
      : undefined;
  emitter.emit(ScanEventName.DISCOVERY_FINISHED, {
    totalCandidates: discovered,
    totalFiles: cFiles.length,
    ...(warning ? { warning } : {}),
  });

  // ── Investigation (agentic; optional in M2) ──
  let investigationOutcome: InvestigationOutcome | undefined;
  if (deps.investigation && input.analysisMode === AnalysisMode.LLM_ASSISTED) {
    investigationOutcome = await deps.investigation.run(candidates, {
      repoPath: input.repoPath,
      buildCommand: input.buildCommand,
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
    });
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
