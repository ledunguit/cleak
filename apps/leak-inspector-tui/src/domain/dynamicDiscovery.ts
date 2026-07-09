/**
 * Dynamic-only discovery (the ablation `static=false` axis). Instead of finding
 * allocation candidates statically (candidateScan), it RUNS the program under
 * LeakSanitizer and synthesizes one candidate per distinct runtime leak site (the
 * user-code allocation frame of each LSan finding). This is the discovery half of
 * baselines B2 (dynamic-only) and B5 (dynamic-only + LLM fusion).
 *
 * It reuses the deterministic dynamic primitives (`runDeterministicDynamic` →
 * `leakSiteFromFinding`) so the run is reproducible and the synthesized sites agree
 * with the evidence that `reconcileDynamicEvidence` later attaches. Requires a
 * `buildCommand` (you can't run what you can't build); with none it yields nothing.
 */

import { loadMcpTools, type McpClient } from '@cleak/agent-core';
import type { LeakCandidate } from '@cleak/common/types';
import { mcpToolFlags } from './mcpToolPlan';
import { normalizeCandidate } from './candidateState';
import {
  createDynamicRunStore,
  runDeterministicDynamic,
  leakSiteFromFinding,
  type DynamicRunStore,
} from './dynamicEvidence';
import type { PathResolver } from './pathResolver';

/**
 * Synthesize one LeakCandidate per distinct runtime leak site from a populated
 * dynamic store. Deduped by `file:line`; ordered by first appearance so the
 * candidate set is deterministic. Only successful runs contribute.
 */
export function synthesizeCandidatesFromStore(store: DynamicRunStore, pathResolver: PathResolver): LeakCandidate[] {
  const bySite = new Map<string, LeakCandidate>();
  for (const run of store.runs) {
    if (!run.success) continue;
    for (const finding of run.findings) {
      const site = leakSiteFromFinding(finding, pathResolver);
      if (!site.file || !site.line) continue; // a leak with no user frame can't be a scoreable site
      const key = `${site.file}:${site.line}`;
      if (bySite.has(key)) continue;
      bySite.set(
        key,
        normalizeCandidate(
          {
            functionName: site.function,
            filePath: site.file,
            lineNumber: site.line,
            allocationSite: key,
            allocationType: finding.allocationType || finding.allocation_type || 'runtime_leak',
            // The site was observed leaking at runtime — the strongest discovery signal.
            confidence: 'high',
            context: String(finding.message || finding.rawOutput || finding.raw_output || '').slice(0, 400),
          },
          (p) => p, // site paths are already host paths (leakSiteFromFinding resolved them)
        ),
      );
    }
  }
  return [...bySite.values()];
}

/**
 * Run the deterministic dynamic stage with NO pre-existing candidates and return
 * both the run store (for the caller to `reconcileDynamicEvidence` against the
 * synthesized bundles) and the synthesized candidates. Returns an empty result if
 * the analyzer is unreachable, tools are missing, or the build/run produced nothing.
 */
export async function runDynamicOnlyDiscovery(
  dynamicClient: McpClient,
  opts: { repoPath: string; buildCommand: string; pathResolver: PathResolver; abortSignal?: AbortSignal; onNotice?: (t: string) => void },
): Promise<{ store: DynamicRunStore; candidates: LeakCandidate[]; ran: boolean }> {
  const store = createDynamicRunStore();
  let tools;
  try {
    tools = await loadMcpTools(dynamicClient, mcpToolFlags);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onNotice?.(`dynamic-only discovery: analyzer unreachable (${msg}) — no candidates`);
    return { store, candidates: [], ran: false };
  }
  const ran = await runDeterministicDynamic({
    tools,
    store,
    repoPath: opts.repoPath,
    buildCommand: opts.buildCommand,
    pathResolver: opts.pathResolver,
    toolCtx: { cwd: opts.repoPath, abortSignal: opts.abortSignal },
    onNotice: opts.onNotice,
  });
  const candidates = synthesizeCandidatesFromStore(store, opts.pathResolver);
  return { store, candidates, ran };
}
