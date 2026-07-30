/**
 * Dynamic verification of static ownership-transfer CLAIMS. The heuristic judge
 * (`packages/common/src/analysis/heuristic-judge.ts`) applies a real score
 * PENALTY (-0.25, or -0.1 with a correlated runtime leak) whenever static
 * analysis claims a function's `ownershipCarrier.kind` is `'return_value'` or
 * `'parameter'` — i.e. "this function hands out / consumes heap ownership, so
 * back off flagging a leak here." But that claim (`ownership-analysis.service.ts`'s
 * `inferOwnershipSummary`) is purely LEXICAL: a parameter is "consumed" if its
 * NAME merely matches something in `freedVariables` (no path-sensitivity — the
 * free could be conditional or on the wrong branch), and a return value is
 * "owned" if its variable NAME textually appears in a return statement (regex
 * substring match, not real dataflow). A wrongly-trusted claim silently
 * SUPPRESSES a real leak — a false negative with no contradicting signal today.
 *
 * This module harness-verifies the specific claim for a candidate's function
 * WHEN it's actually load-bearing (see `hasLeakShapedEvidence`), using the exact
 * same "call once, never free, read ASan's leak signal" mechanism as
 * `allocatorVerification.ts` — reused directly (`buildAllocatorHarnessSource`,
 * `classifyAllocatorRun`) for the `return_value` case, since a return-value
 * ownership claim IS an allocator claim. The `parameter` case is new (a single
 * malloc'd block passed in, never freed by the harness) with INVERTED polarity:
 * a leak here means the function did NOT free the parameter, refuting the claim.
 *
 * Runs BEFORE the heuristic-verdict loop (`workflowInvestigation.ts`) so a
 * refutation actually changes the outcome instead of arriving too late — it
 * clears the false claim in-place in both places the judge reads it
 * (`staticStore` and `bundle.staticEvidence`).
 */

import { McpClient, mapWithLimit } from '@cleak/agent-core';
import { coerceToObject } from './mcpResult';
import type { PathResolver } from './pathResolver';
import type { StaticContextStore } from './staticContext';
import type { LeakBundle, OwnershipSummary } from '@cleak/common/types';
import {
  type Signature,
  type VerificationStatus,
  type RawFinding,
  synthesizeArg,
  declOrInclude,
  STANDARD_PREAMBLE,
  buildAllocatorHarnessSource,
  classifyAllocatorRun,
  isPointerReturn,
  runOneHarness,
} from './allocatorVerification';

export interface OwnershipVerificationConfig {
  enabled: boolean;
  maxVerifications: number;
  concurrency: number;
  timeoutMs: number;
}

export interface VerifyOwnershipOptions {
  repoPath: string;
  buildCommand: string;
  staticClient: McpClient;
  dynamicClient: McpClient;
  pathResolver: PathResolver;
  cfg: OwnershipVerificationConfig;
  onNotice?: (text: string) => void;
}

export interface OwnershipVerificationSummary {
  confirmed: number;
  refuted: number;
}

/**
 * Approximates the heuristic judge's own gating for when the ownership penalty
 * actually applies (`heuristic-judge.ts:180-207`) — intentionally a little
 * BROADER than the exact source (no file re-read needed): any raw alloc/free
 * imbalance or reachable-leak-path signal that a `kind !== 'none'` ownership
 * claim would otherwise be suppressing. Over-triggering just costs a harness run
 * within `maxVerifications`; under-triggering would miss a real false negative.
 */
function hasLeakShapedEvidence(bundle: LeakBundle, staticCtx: Record<string, any>): boolean {
  const se = bundle.staticEvidence;
  if ((se?.allocFreePairs ?? []).some((p) => p.status !== 'paired')) return true;
  if ((se?.feasibleLeakPaths ?? []).some((p) => p.reachable && p.leakRisk !== 'none')) return true;
  if ((se?.feasibleLeakPaths ?? []).length > 0) return true;
  const hasStaticFree = staticCtx?.hasExplicitFree === true;
  const hasStaticAllocation = (staticCtx?.allocations ?? []).length > 0;
  return hasStaticAllocation && !hasStaticFree;
}

/** Parameter-consumption harness: pass a generic heap block into the ONE flagged
 * parameter (all others get the usual deterministic defaults), call once, never
 * free it again in the harness. */
export function buildParameterConsumptionHarnessSource(
  functionName: string,
  sig: Signature,
  analyzerFilePath: string,
  paramIndex: number,
): string {
  const included = new Set<string>();
  const decl = declOrInclude(sig, analyzerFilePath, functionName, included);
  const args = sig.parameters.map((p, i) => (i === paramIndex ? '(void*)heap_block' : synthesizeArg(p))).join(', ');
  return [
    STANDARD_PREAMBLE,
    decl ?? '',
    'int main(void) {',
    '    void *heap_block = malloc(64);',
    `    ${functionName}(${args});`,
    '    return 0;',
    '}',
  ]
    .filter(Boolean)
    .join('\n');
}

/** INVERTED polarity vs `classifyAllocatorRun`: here a leak means the function
 * did NOT free/consume the parameter as claimed (refutes it); a clean run means
 * it did (confirms it). */
export function classifyOwnershipParameterRun(success: boolean, findings: RawFinding[]): VerificationStatus {
  if (!success) return 'unverified';
  if (findings.some((f) => /SEGV|overflow|abort/i.test(f.kind || ''))) return 'unverified';
  if (findings.some((f) => /leak/i.test(f.kind || ''))) return 'refuted';
  return 'confirmed';
}

function clearOwnershipClaim(bundle: LeakBundle, staticStore: StaticContextStore): void {
  const ctx = staticStore.get(bundle.bundleId);
  if (ctx) {
    if (ctx.ownershipSummary) {
      ctx.ownershipSummary = { ...ctx.ownershipSummary, ownershipCarrier: { kind: 'none' }, verification: 'refuted' };
    }
    if (ctx.ownership) {
      ctx.ownership = { ...ctx.ownership, ownershipType: 'refuted_by_dynamic_check' };
    }
  }
  if (bundle.staticEvidence?.ownership) {
    bundle.staticEvidence = {
      ...bundle.staticEvidence,
      ownership: { ...bundle.staticEvidence.ownership, ownershipCarrier: { kind: 'none' }, verification: 'refuted' },
    };
  }
}

/**
 * Verify ownership claims for candidates where the claim is load-bearing.
 * REFUTED claims are cleared in-place (bundle + staticStore) before the caller's
 * heuristic-verdict loop runs. CONFIRMED claims are tagged for transparency only.
 */
export async function verifyOwnershipClaims(
  bundles: LeakBundle[],
  staticStore: StaticContextStore,
  opts: VerifyOwnershipOptions,
): Promise<OwnershipVerificationSummary> {
  const { repoPath, buildCommand, staticClient, dynamicClient, pathResolver, cfg, onNotice } = opts;
  const summary: OwnershipVerificationSummary = { confirmed: 0, refuted: 0 };

  const candidates = bundles.filter((b) => {
    const ctx = staticStore.get(b.bundleId);
    return !!ctx && hasLeakShapedEvidence(b, ctx);
  });
  if (candidates.length === 0) return summary;

  // `ownershipSummary` reads files SERVER-SIDE (needs a shared filesystem, like
  // `interproceduralFlow`/`indexFiles` — excluded from `CONTENT_CAPABLE_TOOLS` for
  // exactly this reason) and takes the WHOLE file set in one call, not one file
  // at a time: `summarize(files: string[], rootPath: string)`
  // (`ownership-analysis.service.ts:10`), exposed as `{files, rootPath}`
  // (`static-mcp-server.ts:104-107`) — analyzer-side paths, dedupe by file.
  const analyzerRepoPath = pathResolver.toAnalyzerPath(repoPath);
  const filesToCheck = [...new Set(candidates.map((b) => b.candidate.file_path))];
  const ownershipByKey = new Map<string, OwnershipSummary>();
  try {
    const res = coerceToObject<{ ownerships?: Array<{ functionName?: string; filePath?: string; summary?: OwnershipSummary }> }>(
      await staticClient.callTool('ownershipSummary', {
        files: filesToCheck.map((f) => pathResolver.toAnalyzerPath(f)),
        rootPath: analyzerRepoPath,
      }),
    );
    for (const o of res.ownerships ?? []) {
      if (!o?.functionName || !o.summary || !o.filePath) continue;
      const hostFile = pathResolver.toHostPath(o.filePath);
      ownershipByKey.set(`${hostFile}::${o.functionName}`, o.summary);
    }
  } catch {
    /* best-effort — no targets found this pass */
  }

  const targets = candidates
    .map((b) => ({ bundle: b, ownership: ownershipByKey.get(`${b.candidate.file_path}::${b.candidate.function_name}`) }))
    .filter((t): t is { bundle: LeakBundle; ownership: OwnershipSummary } => !!t.ownership && t.ownership.ownershipCarrier.kind !== 'none')
    .slice(0, Math.max(1, cfg.maxVerifications));
  if (targets.length === 0) return summary;

  onNotice?.(`ownership-verify: ${targets.length} candidate(s) have a load-bearing ownership claim to check`);

  const timeoutSec = Math.ceil(cfg.timeoutMs / 1000);

  await mapWithLimit(targets, cfg.concurrency, async ({ bundle, ownership }) => {
    const ctx = staticStore.get(bundle.bundleId)!;
    const sig: Signature = {
      filePath: bundle.candidate.file_path,
      returnType: String(ctx.returnType || ''),
      isStaticLinkage: !!ctx.isStaticLinkage,
      parameters: Array.isArray(ctx.parameters) ? ctx.parameters : [],
    };
    const analyzerFilePath = pathResolver.toAnalyzerPath(sig.filePath);
    const closureFiles = sig.isStaticLinkage ? [] : [analyzerFilePath];
    const fnName = bundle.candidate.function_name;

    let status: VerificationStatus = 'unverified';
    if (ownership.ownershipCarrier.kind === 'return_value') {
      if (isPointerReturn(sig.returnType)) {
        const harnessSource = buildAllocatorHarnessSource(fnName, sig, analyzerFilePath);
        status = await runOneHarness({
          dynamicClient,
          analyzerRepoPath,
          buildCommand,
          harnessSource,
          targetFile: analyzerFilePath,
          closureFiles,
          timeoutSec,
          classify: classifyAllocatorRun,
        });
      }
    } else if (ownership.ownershipCarrier.kind === 'parameter') {
      const idx = ownership.ownershipCarrier.index;
      if (typeof idx === 'number' && sig.parameters[idx]) {
        const harnessSource = buildParameterConsumptionHarnessSource(fnName, sig, analyzerFilePath, idx);
        status = await runOneHarness({
          dynamicClient,
          analyzerRepoPath,
          buildCommand,
          harnessSource,
          targetFile: analyzerFilePath,
          closureFiles,
          timeoutSec,
          classify: classifyOwnershipParameterRun,
        });
      }
    }

    if (status === 'unverified') return;
    if (status === 'confirmed') {
      summary.confirmed++;
      ownership.verification = 'confirmed';
      onNotice?.(`ownership-verify: ${fnName} confirmed`);
      return;
    }
    summary.refuted++;
    ownership.verification = 'refuted';
    onNotice?.(`ownership-verify: ${fnName} refuted — clearing the ownership exoneration for this candidate`);
    clearOwnershipClaim(bundle, staticStore);
  });

  return summary;
}

// Exported for unit testing (pure functions, no MCP needed).
export const _internal = {
  hasLeakShapedEvidence,
};
