/**
 * Deterministic dynamic-evidence capture — the dynamic twin of `staticContext.ts`.
 *
 * The dynamic sub-agent (an LLM) used to decide which findings to record via a
 * discretionary evidence tool, which made the attached evidence — and therefore the
 * verdict — non-deterministic run-to-run (the central reproducibility blocker).
 * This module makes evidence capture deterministic: `withDynamicEvidenceCapture`
 * wraps each sanitizer tool and records the RAW run result (no LLM discretion,
 * mirroring `withStaticContextCapture`); after the dynamic stage,
 * `reconcileDynamicEvidence` folds every finding into the best-correlated bundle
 * (a port of the control-plane's deterministic `attachDynamicEvidence`/
 * `attachEvidence`), and `computeDynamicCoverage` sets the explicit, honest
 * `dynamicCoverage` status the judge consumes instead of guessing from
 * `evidence.length`.
 */

import type { Tool } from '@cleak/agent-core';
import {
  correlateEvidence,
  correlationRank,
  deriveDynamicFields,
  computeEvidenceSignature,
  isCorrelated,
  type EvidenceCorrelation,
} from '@cleak/common/analysis/dynamic-evidence';
import { evidenceIndicatesLeak } from '@cleak/common/analysis/judge-shared';
import { ToolKind, type DynamicCoverage, type LeakBundle, type LeakEvidence } from '@cleak/common/types';
import type { PathResolver } from './pathResolver';
import { coerceToObject } from './mcpResult';

/** Which sanitizer produced a run (derived from the MCP tool NAME, not the LLM). */
type DynamicTool = 'asan' | 'lsan' | 'valgrind';

/** One sanitizer invocation's deterministic result — the ledger the reconcile reads. */
export interface DynamicRunRecord {
  tool: DynamicTool;
  runId: string;
  success: boolean;
  findings: any[];
}

export interface DynamicRunStore {
  runs: DynamicRunRecord[];
}

export function createDynamicRunStore(): DynamicRunStore {
  return { runs: [] };
}

/** The dynamic RUN tools whose results carry leak findings (build/read tools excluded). */
const RUN_TOOL_BY_NAME: Record<string, DynamicTool> = {
  asanRun: 'asan',
  lsanRun: 'lsan',
  valgrindMemcheck: 'valgrind',
};

const TOOL_KIND: Record<DynamicTool, ToolKind> = {
  asan: ToolKind.ASAN,
  lsan: ToolKind.LSAN,
  valgrind: ToolKind.VALGRIND,
};


/**
 * Wrap a dynamic run tool so each call's findings are recorded into `store`
 * deterministically — the LLM no longer decides what gets captured. Non-run tools
 * (buildTarget, read_file, …) pass through untouched. Wrap as
 * `withDynamicEvidenceCapture(withHostPathMapping(tool, …), …)` so the capture sees
 * analyzer-resolved finding paths (mirrors the static wrapper layering).
 */
export function withDynamicEvidenceCapture(tool: Tool, store: DynamicRunStore): Tool {
  const dyn = RUN_TOOL_BY_NAME[tool.name];
  if (!dyn) return tool;
  return {
    ...tool,
    call: async (input: any, ctx: any) => {
      const out = await tool.call(input, ctx);
      try {
        const o = coerceToObject(out);
        const findings = Array.isArray(o.findings) ? o.findings : Array.isArray(o.structuredContent?.findings) ? o.structuredContent.findings : [];
        store.runs.push({
          tool: dyn,
          runId: String(o.runId ?? o.run_id ?? o.structuredContent?.runId ?? ''),
          success: o.success !== false, // default true unless explicitly false
          findings,
        });
      } catch {
        /* capture is best-effort — never break the tool call */
      }
      return out;
    },
  };
}

/** Build a normalized LeakEvidence from a raw finding (port of attachDynamicEvidence). */
function findingToEvidence(finding: any, run: DynamicRunRecord, pathResolver: PathResolver): LeakEvidence {
  // Sanitizer stacks put the allocator interceptor (__interceptor_calloc, operator new,
  // malloc/calloc/realloc/strdup) FIRST — the user allocation site is a few frames down.
  // When the finding carries no explicit location, attribute it to the first USER frame
  // so the leak correlates to the candidate instead of dropping to "same file" / unlinked.
  const isUserFrame = (f: any) =>
    f?.file &&
    !/^(__interceptor_|__libc_|_start$|operator new|malloc$|calloc$|realloc$|strdup$|aligned_alloc$)/.test(f.function || '') &&
    !/sysdeps|libc_start_call_main|\/usr\/(lib|include)\//.test(f.file);
  const userFrame = (finding.stack || []).find(isUserFrame) || (finding.stack || []).find((f: any) => f?.file);
  const locFile = finding.filePath || finding.file_path || finding.location?.file || userFrame?.file || '';
  const locLine = finding.lineNumber ?? finding.line_number ?? finding.location?.line ?? userFrame?.line ?? 0;
  const base: LeakEvidence = {
    tool: TOOL_KIND[run.tool],
    runId: run.runId,
    function_name: finding.functionName || finding.function_name || finding.location?.function || userFrame?.function || '',
    file_path: pathResolver.toHostPath(locFile),
    line_number: Number(locLine) || 0,
    bytes_lost: Number(finding.bytesLost ?? finding.bytes_lost ?? finding.aux?.leak?.bytes ?? finding.aux?.size ?? 0),
    blocks_lost: Number(finding.blocksLost ?? finding.blocks_lost ?? finding.aux?.leak?.blocks ?? 0),
    severity: finding.severity || 'medium',
    stack_trace:
      finding.stackTrace || finding.stack_trace || (finding.stack || []).map((s: any) => `${s.function} at ${s.file}:${s.line}`).join('\n'),
    raw_output: finding.message || finding.rawOutput || finding.raw_output || '',
  };
  const rawLeakKind = finding.allocationType || finding.allocation_type || finding.kind || finding.aux?.leak?.kind || '';
  return deriveDynamicFields(base, { rawLeakKind, rawStack: finding.stack });
}

/** Higher correlation rank wins; ties break by graded confidence, then nearer line.
 * A strict comparison (never true on full equality) keeps the first matching bundle
 * deterministically — order-independent reconcile. */
function isBetterCorrelation(a: EvidenceCorrelation, b: EvidenceCorrelation): boolean {
  const ra = correlationRank(a.correlationMethod);
  const rb = correlationRank(b.correlationMethod);
  if (ra !== rb) return ra > rb;
  if (a.correlationConfidence !== b.correlationConfidence) {
    return a.correlationConfidence > b.correlationConfidence;
  }
  const da = a.correlationDistanceLines ?? Number.POSITIVE_INFINITY;
  const db = b.correlationDistanceLines ?? Number.POSITIVE_INFINITY;
  return da < db;
}

/** Attach one piece of evidence to the best-correlated bundle (port of attachEvidence),
 * skipping if an identical (same-signature) evidence is already present. */
function attachToBest(bundles: LeakBundle[], evidence: LeakEvidence): boolean {
  let best: { bundle: LeakBundle; method: EvidenceCorrelation } | null = null;
  for (const bundle of bundles) {
    const corr = correlateEvidence(evidence, bundle.candidate);
    if (correlationRank(corr.correlationMethod) === 0) continue;
    if (!best || isBetterCorrelation(corr, best.method)) {
      best = { bundle, method: corr };
    }
  }
  if (!best) return false;
  const sig = computeEvidenceSignature(evidence);
  if (best.bundle.evidence.some((e) => computeEvidenceSignature(e) === sig)) return false; // idempotent
  best.bundle.evidence.push({
    ...evidence,
    correlatedToCandidate: best.method.correlatedToCandidate,
    correlationMethod: best.method.correlationMethod,
    correlationDistanceLines: best.method.correlationDistanceLines,
    correlationConfidence: best.method.correlationConfidence,
  });
  return true;
}

/**
 * Deterministically fold every captured run's findings into the bundles. Idempotent
 * and order-independent: the same store + bundles always produce the same evidence.
 */
export function reconcileDynamicEvidence(store: DynamicRunStore, bundles: LeakBundle[], pathResolver: PathResolver): void {
  for (const run of store.runs) {
    if (!run.success) continue;
    for (const finding of run.findings) {
      attachToBest(bundles, findingToEvidence(finding, run, pathResolver));
    }
  }
}

/**
 * The honest coverage status for a bundle after the dynamic stage. `exercised_clean`
 * requires a successful run (which, under the good+bad build, executes the candidate)
 * AND no correlated leak — the signal the judge's precision gate needs and that
 * `evidence.length` could never represent (a clean run emits nothing).
 */
/**
 * Run the dynamic stage DETERMINISTICALLY with a fixed recipe — no LLM in the loop.
 * When the case carries a known `buildCommand`, the only honest way to get a
 * reproducible run (and thus reproducible coverage/verdicts) is to fix WHAT gets
 * built and run: `buildTarget(buildCommand) → lsanRun(a.out)`. The LLM driving the
 * run is the remaining nondeterminism source even after deterministic CAPTURE — it
 * picks different sanitizers/flags across runs. This removes that. Findings are
 * captured into `store` by the same wrapper, so the rest of the pipeline is unchanged.
 * Returns true if a successful run was recorded (caller falls back to the LLM worker
 * otherwise — e.g. an unknown build system with no buildCommand).
 */
export async function runDeterministicDynamic(opts: {
  tools: Tool[];
  store: DynamicRunStore;
  repoPath: string;
  buildCommand: string;
  pathResolver: PathResolver;
  toolCtx: any;
  onNotice?: (text: string) => void;
}): Promise<boolean> {
  const { tools, store, repoPath, buildCommand, pathResolver, toolCtx } = opts;
  const buildTool = tools.find((t) => t.name === 'buildTarget');
  const lsanTool = tools.find((t) => t.name === 'lsanRun');
  if (!buildTool || !lsanTool) {
    opts.onNotice?.('deterministic dynamic: buildTarget/lsanRun unavailable — falling back');
    return false;
  }
  const analyzerRepo = pathResolver.toAnalyzerPath(repoPath);
  let build: any;
  try {
    build = coerceToObject(await buildTool.call({ projectPath: analyzerRepo, buildCommand }, toolCtx));
  } catch (err: any) {
    opts.onNotice?.(`deterministic build threw: ${err?.message ?? err} — falling back`);
    return false;
  }
  if (build.success === false) {
    opts.onNotice?.(`deterministic build failed: ${(build.errors || []).join('; ').slice(0, 200)} — falling back`);
    return false;
  }
  // buildTarget returns an absolute (analyzer-side) binary path; default to the
  // conventional a.out in the project dir when discovery came up empty.
  const binaryPath = String(build.binaryPath || '').trim() || `${analyzerRepo}/a.out`;
  const lsanCaptured = withDynamicEvidenceCapture(lsanTool, store);
  try {
    await lsanCaptured.call({ binaryPath }, toolCtx);
  } catch (err: any) {
    opts.onNotice?.(`deterministic lsanRun threw: ${err?.message ?? err}`);
  }
  return store.runs.some((r) => r.success);
}

export function computeDynamicCoverage(store: DynamicRunStore, bundle: LeakBundle, wantDynamic: boolean): DynamicCoverage {
  if (!wantDynamic) return 'dynamic_off';
  const ranOk = store.runs.some((r) => r.success);
  if (!ranOk) return 'not_exercised';
  const correlatedLeak = bundle.evidence.some((e) => isCorrelated(e.correlationMethod ?? 'none') && evidenceIndicatesLeak(e));
  return correlatedLeak ? 'exercised_leak' : 'exercised_clean';
}
