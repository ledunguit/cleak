/**
 * Per-bundle static-context accumulation. The free-form investigation loop let the
 * model SEE static-tool results but never structured them, so the heuristic judge
 * always ran on an empty `{}` (blind). The workflow's static sub-agents drive the
 * tools; this module deterministically folds each tool's real output into a
 * per-bundle context map (the keys the heuristic judge actually scores:
 * hasExplicitFree, allocations, frees, feasiblePaths, earlyReturnCount, ownership),
 * mirroring the control-plane's `scan-orchestrator` accumulation.
 */

import { basename } from 'node:path';
import { coerceToObject } from './mcpResult';
import type {
  LeakBundle,
  AllocFreePair,
  FeasibleLeakPath,
  OwnershipSummary,
  StaticLeakEvidence,
  ScanBuildDiagnostic,
} from '@cleak/common/types';
import type { Tool } from '@cleak/agent-core';

export type StaticContextStore = Map<string, Record<string, any>>;

/**
 * Merge a partial into a bundle's typed `staticEvidence`, creating it if absent.
 * Keeps the rich artifacts (ownership summary, alloc→free pairs, feasible leak
 * paths) on the bundle so the judge + report can render them, alongside the
 * loose context record used for legacy scoring keys.
 */
function mergeStaticEvidence(bundle: LeakBundle, partial: Partial<StaticLeakEvidence>): void {
  const cur: StaticLeakEvidence = bundle.staticEvidence ?? {
    allocFreePairs: [],
    feasibleLeakPaths: [],
    earlyReturnCount: 0,
    leakyExitPaths: 0,
  };
  bundle.staticEvidence = { ...cur, ...partial };
}

function ctxFor(store: StaticContextStore, bundleId: string): Record<string, any> {
  let c = store.get(bundleId);
  if (!c) {
    c = {};
    store.set(bundleId, c);
  }
  return c;
}

const sameFile = (a: string, b: string): boolean =>
  a === b || (!!a && !!b && basename(a) === basename(b));

/**
 * Fold one static tool's (input, result) into the per-bundle context for every
 * bundle in `bundles` that the call pertains to. Lenient file matching (basename)
 * tolerates abs-vs-relative path differences.
 */
export function foldStaticResult(
  store: StaticContextStore,
  toolName: string,
  input: any,
  result: unknown,
  bundles: LeakBundle[],
): void {
  const out = coerceToObject(result);
  const filePath: string = input?.filePath ?? input?.file_path ?? '';
  const fn: string | undefined = input?.functionName ?? input?.function_name;
  const line: number | undefined = input?.lineNumber ?? input?.line_number;
  const inFile = bundles.filter((b) => sameFile(b.candidate.file_path, filePath));

  switch (toolName) {
    case 'functionSummary': {
      // result: { summary: JSON-string, allocations: string[], frees: string[] }
      const targets = fn ? inFile.filter((b) => b.candidate.function_name === fn) : inFile;
      const allocations = Array.isArray(out.allocations) ? out.allocations : [];
      const frees = Array.isArray(out.frees) ? out.frees : [];
      let leaky = 0;
      try {
        const s = typeof out.summary === 'string' ? JSON.parse(out.summary) : out.summary;
        leaky = Number(s?.leaky_exit_paths ?? 0);
      } catch {
        /* summary not parseable */
      }
      const pairs: AllocFreePair[] = Array.isArray(out.pairs) ? out.pairs : [];
      for (const b of targets) {
        const c = ctxFor(store, b.bundleId);
        c.allocations = allocations;
        c.frees = frees;
        c.hasExplicitFree = frees.length > 0;
        if (leaky > 0) c.leakyExitPaths = leaky;
        if (pairs.length) {
          c.allocFreePairs = pairs;
          mergeStaticEvidence(b, { allocFreePairs: pairs, leakyExitPaths: leaky });
        }
      }
      break;
    }
    case 'pathConstraints': {
      // result: { constraints, feasiblePaths, feasibleLeakPaths, exitPaths, earlyReturnCount }
      const exact = inFile.filter((b) => line != null && b.candidate.line_number === line);
      const targets = exact.length ? exact : inFile;
      const leakPaths: FeasibleLeakPath[] = Array.isArray(out.feasibleLeakPaths) ? out.feasibleLeakPaths : [];
      for (const b of targets) {
        const c = ctxFor(store, b.bundleId);
        if (Array.isArray(out.feasiblePaths)) c.feasiblePaths = out.feasiblePaths;
        if (Array.isArray(out.constraints)) c.constraints = out.constraints;
        if (out.earlyReturnCount != null) c.earlyReturnCount = Number(out.earlyReturnCount);
        if (leakPaths.length) c.feasibleLeakPaths = leakPaths;
        mergeStaticEvidence(b, {
          feasibleLeakPaths: leakPaths,
          earlyReturnCount: Number(out.earlyReturnCount ?? 0),
        });
      }
      break;
    }
    case 'ownershipSummary': {
      // result: { ownerships: [{ functionName, ..., summary: OwnershipSummary }] }
      const ownerships: any[] = Array.isArray(out.ownerships) ? out.ownerships : [];
      for (const o of ownerships) {
        const summary: OwnershipSummary | undefined = o?.summary;
        if (!summary) continue;
        for (const b of inFile.filter((b) => b.candidate.function_name === o.functionName)) {
          const c = ctxFor(store, b.bundleId);
          c.ownershipSummary = summary;
          c.ownership = { ownershipType: summary.ownershipType };
          mergeStaticEvidence(b, { ownership: summary });
        }
      }
      break;
    }
    case 'astScan': {
      // result: { patterns, functionSummaries: [{ functionName, earlyReturnCount, leakyExitPaths }] }
      const summaries: any[] = Array.isArray(out.functionSummaries) ? out.functionSummaries : [];
      for (const fs of summaries) {
        for (const b of inFile.filter((b) => b.candidate.function_name === fs.functionName)) {
          const c = ctxFor(store, b.bundleId);
          if (fs.earlyReturnCount != null) c.earlyReturnCount = Number(fs.earlyReturnCount);
          if (fs.leakyExitPaths != null) c.leakyExitPaths = Number(fs.leakyExitPaths);
        }
      }
      break;
    }
    case 'ownershipConventions': {
      // result: { rules: [{ pattern, conventionType }] } — coarse: a leak-risk rule whose
      // pattern names a candidate's function marks that bundle malloc_without_free.
      const rules: any[] = Array.isArray(out.rules) ? out.rules : [];
      const leakKinds = new Set(['missing_free', 'early_return_leak', 'loop_leak', 'leak_risk']);
      for (const b of inFile) {
        const hit = rules.some(
          (r) => leakKinds.has(r.conventionType) && typeof r.pattern === 'string' && r.pattern.includes(b.candidate.function_name),
        );
        if (hit) ctxFor(store, b.bundleId).ownership = { ownershipType: 'malloc_without_free' };
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Attach project-level Clang `scan-build` diagnostics to every bundle whose candidate
 * file matches. scan-build is project-level + one-shot, so it does NOT go through the
 * per-file `foldStaticResult` path — it's matched against all bundles here. The judge
 * then corroborates a candidate when a diagnostic sits near its allocation line.
 * Returns the number of bundles that got at least one diagnostic.
 */
export function attachScanBuildDiagnostics(
  bundles: LeakBundle[],
  findings: Array<Record<string, any>>,
): number {
  let attached = 0;
  for (const b of bundles) {
    const diags: ScanBuildDiagnostic[] = findings
      .filter((f) => sameFile(String(f.file_path ?? f.file ?? ''), b.candidate.file_path))
      .map((f) => ({
        file: String(f.file_path ?? f.file ?? ''),
        line: Number(f.line_number ?? f.line ?? 0),
        message: String(f.context ?? f.message ?? ''),
        confidence: (['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'medium') as
          | 'high'
          | 'medium'
          | 'low',
      }));
    if (diags.length) {
      mergeStaticEvidence(b, { scanBuildDiagnostics: diags });
      attached++;
    }
  }
  return attached;
}

/**
 * Derive ADDITIVE interprocedural leak paths from an `interproceduralFlow` result.
 *
 * Recall-direction ONLY, variable-level: emit a FeasibleLeakPath when the candidate's
 * function allocates a variable that is freed NOWHERE reachable (not locally, not in any
 * callee) — the `unreconciledAllocVars` the (allocator-aware) service computed by matching
 * alloc/free variable names across frames. We never mark an allocation as freed/paired
 * here (that could exonerate and SUPPRESS a true leak); the worst case is an extra
 * (possibly false) leak signal, which the precision metric catches. Returns [] when every
 * allocation of the candidate function is reconciled somewhere in the call graph.
 */
export function interproceduralLeakPaths(
  result: unknown,
  candidate: { function_name: string; line_number: number },
): FeasibleLeakPath[] {
  const out = coerceToObject(result);
  const unreconciled: string[] = Array.isArray(out.unreconciledAllocVars)
    ? out.unreconciledAllocVars.map(String)
    : [];
  if (!unreconciled.length) return [];
  return [
    {
      kind: 'fallthrough',
      exitLine: candidate.line_number,
      reachable: true,
      conditions: [],
      unreconciledAllocations: unreconciled,
      leakRisk: 'high',
      narrative: `interprocedural: '${candidate.function_name}' allocates ${unreconciled.join(', ')} — freed nowhere reachable through any callee`,
      feasibilityChecked: 'heuristic',
    },
  ];
}

/** Append feasible leak paths to a bundle's staticEvidence (merge replaces; this concats). */
export function appendFeasibleLeakPaths(bundle: LeakBundle, paths: FeasibleLeakPath[]): void {
  if (!paths.length) return;
  const cur: StaticLeakEvidence = bundle.staticEvidence ?? {
    allocFreePairs: [],
    feasibleLeakPaths: [],
    earlyReturnCount: 0,
    leakyExitPaths: 0,
  };
  bundle.staticEvidence = { ...cur, feasibleLeakPaths: [...(cur.feasibleLeakPaths || []), ...paths] };
}

/**
 * Wrap a (host-content-resolved) static tool so each successful call folds its
 * result into `store`. Wrap as `withHostContent(withStaticContextCapture(tool))`
 * so the capture sees the resolved absolute `filePath`.
 */
export function withStaticContextCapture(tool: Tool, store: StaticContextStore, bundles: LeakBundle[]): Tool {
  return {
    ...tool,
    call: async (input: any, ctx: any) => {
      const out = await tool.call(input, ctx);
      try {
        foldStaticResult(store, tool.name, input, out, bundles);
      } catch {
        /* folding is best-effort — never break the tool call */
      }
      return out;
    },
  };
}
