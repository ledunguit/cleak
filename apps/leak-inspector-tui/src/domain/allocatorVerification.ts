/**
 * Dynamic verification of the LLM-discovered allocator/deallocator PROFILE
 * (`allocatorProfiler.ts`). The LLM proposes candidate names from reading source
 * text; this module checks each one MECHANICALLY — compile a tiny single-call
 * harness (reusing Stage B2's `buildHarness`/`asanRun` MCP tools UNCHANGED) and
 * read AddressSanitizer's own leak/invalid-free signal. No LLM call: "does
 * calling X leak heap memory" is answerable deterministically once we have a
 * real signature (from `functionSummary`) and a plausible default argument set.
 *
 * Asymmetric on purpose: allocator/reallocator candidates can be actively
 * REFUTED (single-call test — we deliberately never free, so a clean run is a
 * clean refutation). Deallocator candidates are only ever CONFIRMED or left
 * UNVERIFIED, never refuted — the harness needs a paired allocator call first,
 * and any ambiguity there (bad synthesized args) could produce a false
 * invalid-free that would wrongly drop a real deallocator, which is worse than
 * today's behavior (a missing deallocator makes the leak checker think that
 * free-call never reconciles an allocation, inflating false positives).
 */

import { McpClient, mapWithLimit } from '@cleak/agent-core';
import { walkCFiles, readFileSafe } from './fileWalk';
import { coerceToObject } from './mcpResult';
import type { PathResolver } from './pathResolver';
import type { AllocatorProfile } from './allocatorProfiler';

export interface AllocatorVerificationConfig {
  enabled: boolean;
  maxVerifications: number;
  concurrency: number;
  timeoutMs: number;
}

export type VerificationStatus = 'confirmed' | 'refuted' | 'unverified';

export interface VerificationSummary {
  allocators: Record<string, VerificationStatus>;
  deallocators: Record<string, VerificationStatus>;
}

// Exported so other harness-verification modules (e.g. `ownershipVerification.ts`)
// can reuse the shape + the helpers below instead of re-deriving them.
export interface Signature {
  filePath: string;
  returnType: string;
  isStaticLinkage: boolean;
  parameters: { name: string; type: string; isPointer: boolean }[];
}

export interface RawFinding {
  kind?: string;
}

// ── Locate a candidate's real signature via the SAME functionSummary fields
// Stage B2's harness worker uses (returnType/parameters/isStaticLinkage). A wrong
// file guess just returns no match and the next candidate file is tried — never
// crashes, self-correcting by construction. ──

async function locateSignature(name: string, files: string[], staticClient: McpClient): Promise<Signature | null> {
  const nameRe = new RegExp(`\\b${name}\\b`);
  let checked = 0;
  for (const f of files) {
    if (checked >= 5) break;
    const content = readFileSafe(f);
    if (!content || !nameRe.test(content)) continue;
    checked++;
    try {
      const res = coerceToObject<{ summary?: unknown }>(
        await staticClient.callTool('functionSummary', { filePath: f, content, functionName: name }),
      );
      const parsed: any = typeof res.summary === 'string' ? JSON.parse(res.summary) : res.summary;
      if (parsed && parsed.function_name === name) {
        return {
          filePath: f,
          returnType: String(parsed.return_type || ''),
          isStaticLinkage: !!parsed.is_static_linkage,
          parameters: Array.isArray(parsed.parameters) ? parsed.parameters : [],
        };
      }
    } catch {
      /* try the next candidate file */
    }
  }
  return null;
}

export function isPointerReturn(returnType: string): boolean {
  return /\*/.test(returnType);
}

// ── Deterministic default-argument synthesis — no LLM. Good enough to reach a
// non-crashing call for the common "returns owned memory" allocator shape; a bad
// guess just yields `unverified` (see classifiers below), never a wrong verdict. ──

export function synthesizeArg(p: { name: string; type: string; isPointer: boolean }): string {
  if (p.isPointer) {
    if (/char/i.test(p.type)) return '"x"';
    return 'NULL';
  }
  if (/size|len|count|\bn\b/i.test(p.name)) return '8';
  return '1';
}

export function declOrInclude(sig: Signature, analyzerFilePath: string, functionName: string, included: Set<string>): string | null {
  if (sig.isStaticLinkage) {
    if (included.has(analyzerFilePath)) return null; // already #included by a prior decl in this harness
    included.add(analyzerFilePath);
    return `#include "${analyzerFilePath}"`;
  }
  const paramTypes = sig.parameters.map((p) => p.type).join(', ') || 'void';
  return `extern ${sig.returnType || 'void'} ${functionName}(${paramTypes});`;
}

/** Standard headers so `extern`-declared parameter types (`size_t`, …) and `NULL`
 * resolve without needing the target's own (unknown, possibly large) include
 * chain — always safe to add, never conflicts with an `#include`d target file. */
export const STANDARD_PREAMBLE = '#include <stddef.h>\n#include <stdlib.h>';

export function buildAllocatorHarnessSource(functionName: string, sig: Signature, analyzerFilePath: string): string {
  const included = new Set<string>();
  const decl = declOrInclude(sig, analyzerFilePath, functionName, included);
  const args = sig.parameters.map(synthesizeArg).join(', ');
  return [
    STANDARD_PREAMBLE,
    decl ?? '',
    'int main(void) {',
    // Deliberately never freed — a leak proves heap allocation happened.
    `    void *p = (void*)${functionName}(${args});`,
    '    (void)p;',
    '    return 0;',
    '}',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildDeallocatorHarnessSource(
  deallocName: string,
  deallocSig: Signature,
  deallocAnalyzerPath: string,
  allocName: string,
  allocSig: Signature,
  allocAnalyzerPath: string,
): string {
  const included = new Set<string>();
  const decls = [
    declOrInclude(allocSig, allocAnalyzerPath, allocName, included),
    declOrInclude(deallocSig, deallocAnalyzerPath, deallocName, included),
  ].filter((d): d is string => Boolean(d));
  const allocArgs = allocSig.parameters.map(synthesizeArg).join(', ');
  const deallocParamType = deallocSig.parameters[0]?.type || 'void *';
  return [
    STANDARD_PREAMBLE,
    ...decls,
    'int main(void) {',
    `    void *p = (void*)${allocName}(${allocArgs});`,
    `    ${deallocName}((${deallocParamType})p);`,
    '    return 0;',
    '}',
  ].join('\n');
}

// ── Classification — read AddressSanitizer's own error text (`kind`, already
// captured by the existing `parseAsanOutput` in dynamic-analyzer, unchanged). ──

export function classifyAllocatorRun(success: boolean, findings: RawFinding[]): VerificationStatus {
  if (!success) return 'unverified';
  if (findings.some((f) => /SEGV|overflow|abort/i.test(f.kind || ''))) return 'unverified'; // bad synthesized args, not evidence
  if (findings.some((f) => /leak/i.test(f.kind || ''))) return 'confirmed';
  return 'refuted'; // ran clean, never freed, no leak reported ⇒ not a heap allocator
}

function classifyDeallocatorRun(success: boolean, findings: RawFinding[]): VerificationStatus {
  if (!success) return 'unverified';
  if (findings.length === 0) return 'confirmed'; // paired alloc+free, no leak, no invalid-free
  return 'unverified'; // NEVER actively refute — see module doc
}

export async function runOneHarness(opts: {
  dynamicClient: McpClient;
  analyzerRepoPath: string;
  buildCommand: string;
  harnessSource: string;
  targetFile: string;
  closureFiles: string[];
  timeoutSec: number;
  classify: (success: boolean, findings: RawFinding[]) => VerificationStatus;
}): Promise<VerificationStatus> {
  try {
    const build = coerceToObject<{ success?: boolean; binaryPath?: string }>(
      await opts.dynamicClient.callTool('buildHarness', {
        projectPath: opts.analyzerRepoPath,
        buildCommand: opts.buildCommand,
        harnessSource: opts.harnessSource,
        targetFile: opts.targetFile,
        closureFiles: opts.closureFiles,
        entryStyle: 'single',
        timeoutSec: opts.timeoutSec,
      }),
    );
    if (!build.success || !build.binaryPath) return 'unverified';
    const run = coerceToObject<{ success?: boolean; findings?: RawFinding[] }>(
      await opts.dynamicClient.callTool('asanRun', { binaryPath: build.binaryPath, timeoutSec: opts.timeoutSec }),
    );
    return opts.classify(run.success !== false, Array.isArray(run.findings) ? run.findings : []);
  } catch {
    return 'unverified';
  }
}

export interface VerifyAllocatorProfileOptions {
  repoPath: string;
  buildCommand: string;
  staticClient: McpClient;
  dynamicClient: McpClient;
  pathResolver: PathResolver;
  cfg: AllocatorVerificationConfig;
  onNotice?: (text: string) => void;
}

/**
 * Verify a profile's candidates, dropping REFUTED allocators/reallocators and
 * stamping `verifiedAt`. Deallocators are never dropped (asymmetric design, see
 * module doc) — only surfaced in the returned `summary` for visibility.
 */
export async function verifyAllocatorProfile(
  profile: AllocatorProfile,
  opts: VerifyAllocatorProfileOptions,
): Promise<{ profile: AllocatorProfile; summary: VerificationSummary }> {
  const { repoPath, buildCommand, staticClient, dynamicClient, pathResolver, cfg, onNotice } = opts;
  const summary: VerificationSummary = { allocators: {}, deallocators: {} };

  const allocCandidates = [...profile.allocators, ...profile.reallocators];
  const totalCap = Math.max(1, cfg.maxVerifications);
  const allocSlice = allocCandidates.slice(0, totalCap);
  const dealloSlice = profile.deallocators.slice(0, Math.max(0, totalCap - allocSlice.length));

  if (allocSlice.length === 0 && dealloSlice.length === 0) {
    return { profile: { ...profile, verifiedAt: new Date().toISOString() }, summary };
  }

  const files = walkCFiles(repoPath);
  const analyzerRepoPath = pathResolver.toAnalyzerPath(repoPath);
  const timeoutSec = Math.ceil(cfg.timeoutMs / 1000);

  const sigCache = new Map<string, Signature | null>();
  const getSig = async (name: string): Promise<Signature | null> => {
    if (sigCache.has(name)) return sigCache.get(name)!;
    const sig = await locateSignature(name, files, staticClient);
    sigCache.set(name, sig);
    return sig;
  };

  const refutedAllocators = new Set<string>();

  await mapWithLimit(allocSlice, cfg.concurrency, async (name) => {
    const sig = await getSig(name);
    if (!sig || !isPointerReturn(sig.returnType)) {
      summary.allocators[name] = 'unverified'; // no signature found, or an out-param shape v1 doesn't handle
      return;
    }
    const analyzerFilePath = pathResolver.toAnalyzerPath(sig.filePath);
    const harnessSource = buildAllocatorHarnessSource(name, sig, analyzerFilePath);
    const status = await runOneHarness({
      dynamicClient,
      analyzerRepoPath,
      buildCommand,
      harnessSource,
      targetFile: analyzerFilePath,
      closureFiles: sig.isStaticLinkage ? [] : [analyzerFilePath],
      timeoutSec,
      classify: classifyAllocatorRun,
    });
    summary.allocators[name] = status;
    if (status === 'refuted') refutedAllocators.add(name);
    if (status !== 'unverified') onNotice?.(`allocator-verify: ${name} → ${status}`);
  });

  // Deallocator pairing needs at least one CONFIRMED allocator from this same pass.
  const confirmedAllocatorName = allocSlice.find((n) => summary.allocators[n] === 'confirmed');
  if (confirmedAllocatorName && dealloSlice.length > 0) {
    const pairAllocSig = await getSig(confirmedAllocatorName);
    if (pairAllocSig) {
      const allocAnalyzerPath = pathResolver.toAnalyzerPath(pairAllocSig.filePath);
      await mapWithLimit(dealloSlice, cfg.concurrency, async (name) => {
        const sig = await getSig(name);
        if (!sig) {
          summary.deallocators[name] = 'unverified';
          return;
        }
        const deallocAnalyzerPath = pathResolver.toAnalyzerPath(sig.filePath);
        const harnessSource = buildDeallocatorHarnessSource(
          name,
          sig,
          deallocAnalyzerPath,
          confirmedAllocatorName,
          pairAllocSig,
          allocAnalyzerPath,
        );
        const closureFiles = [
          ...(pairAllocSig.isStaticLinkage ? [] : [allocAnalyzerPath]),
          ...(sig.isStaticLinkage ? [] : [deallocAnalyzerPath]),
        ];
        const status = await runOneHarness({
          dynamicClient,
          analyzerRepoPath,
          buildCommand,
          harnessSource,
          targetFile: allocAnalyzerPath,
          closureFiles,
          timeoutSec,
          classify: classifyDeallocatorRun,
        });
        summary.deallocators[name] = status;
        if (status !== 'unverified') onNotice?.(`deallocator-verify: ${name} → ${status}`);
      });
    }
  }

  const filteredProfile: AllocatorProfile = {
    ...profile,
    allocators: profile.allocators.filter((n) => !refutedAllocators.has(n)),
    reallocators: profile.reallocators.filter((n) => !refutedAllocators.has(n)),
    verifiedAt: new Date().toISOString(),
  };
  return { profile: filteredProfile, summary };
}

// Exported for unit testing (pure functions, no MCP needed).
export const _internal = {
  synthesizeArg,
  buildAllocatorHarnessSource,
  buildDeallocatorHarnessSource,
  classifyAllocatorRun,
  classifyDeallocatorRun,
  isPointerReturn,
};
