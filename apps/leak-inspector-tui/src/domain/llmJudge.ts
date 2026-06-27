/**
 * Single-bundle LLM judge for the workflow's hybrid judging stage. The heuristic
 * judge scores every bundle from the (now-populated) static context + evidence;
 * only BORDERLINE bundles are escalated here for an LLM verdict. We ask the model
 * for a compact JSON verdict and run it through the shared `enrichLeakVerdict` so
 * it still ships a root cause + source-anchored repair diff.
 */

import { z } from 'zod';
import { readFileSafe } from './fileWalk';
import { THRESHOLDS } from './thresholds';
import { enrichLeakVerdict } from '@cleak/common/analysis/heuristic-judge';
import { deriveFusion } from '@cleak/common/analysis/consensus-judge';
import { enclosingFunctionSnippet, isLeakVerdictString, evidenceIndicatesLeak } from '@cleak/common/analysis/judge-shared';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '@cleak/common/types';
import type { CallModel } from '@cleak/agent-core';

const SYSTEM_PROMPT = [
  `You are an expert C/C++ memory-leak analyst. Decide whether ONE allocation is a real leak, using the code, static context, and any runtime evidence provided.`,
  `Respond with a JSON object ONLY (no prose), in this exact shape:`,
  `{"verdict": "confirmed_leak | likely_leak | uncertain | likely_false_positive | false_positive", "confidence": 0.0-1.0, "explanation": "...", "evidence": ["..."]}`,
  `Calibrate using the EVIDENCE, in this priority order:`,
  `- A runtime leak (sanitizer/valgrind) whose allocation site is LINKED to this candidate is decisive → confirmed_leak (confidence ≥ 0.9). Weight by leak kind: definitely_lost / asan_leak ⇒ decisive; possibly_lost ⇒ weak corroboration; still_reachable ⇒ usually benign, lean false_positive.`,
  `- A runtime finding in the SAME FILE but a DIFFERENT site (not linked) is weak — do not treat it as proof for this allocation. still_reachable with no other evidence → false_positive.`,
  `- A CLEAN sanitizer/valgrind run that EXERCISED this allocation and reported NO leak here is strong evidence this is NOT a leak → lean false_positive / likely_false_positive (unless a runtime leak is LINKED to this very allocation).`,
  `- Ownership is decisive for false positives: if the allocation is RETURNED to the caller or its pointer is HANDED OFF to a sink/callback/another function (ownership transferred), freeing it is NOT this function's job. When ownership is transferred AND no runtime leak is linked to THIS allocation, answer likely_false_positive or false_positive — do NOT flag it just because you cannot see the free inside this snippet. An UNPAIRED alloc→free with a reachable leak path and NO ownership transfer → confirmed_leak (≥ 0.85).`,
  `- PATH-SENSITIVE leak: an allocation freed on the main/success path but NOT on an error or early-return path (e.g. \`if (err) return NULL;\` or \`goto fail;\` before the free) IS a leak — confirmed_leak — EVEN IF the value is returned or added to a structure on the success path. Ownership transferring on success does not cover the error path that loses the object. If the static context lists the allocation as freed "on some paths only" (conditional) or names it on a reachable un-freed exit path, treat that as decisive.`,
  `- PARAMETER-ownership leak (allocation_type 'parameter_ownership'): when a function frees a pointer PARAMETER on some paths (taking ownership from the caller, e.g. cJSON's \`merge_patch\` does \`cJSON_Delete(target)\`) but a reachable branch returns WITHOUT freeing it, that branch leaks the parameter — confirmed_leak. The parameter has no allocation site in the function; judge it by the conditional free + the reachable un-freed exit.`,
  `- Freed on all paths / static-global → false_positive (high confidence). Use uncertain only when the evidence is genuinely insufficient.`,
  `- Control flow is concrete, not hypothetical: a constant or scaffolding global such as \`if(1)\`/\`if(0)\` or \`globalReturnsTrue()\` does NOT change between two checks in the SAME function — \`if(1)\` always runs and \`if(0)\` is dead code. If the buffer is freed under the same condition it was allocated (or in the \`else\` of a constant \`if\`), it IS freed. Do NOT call a leak just because the \`free()\` sits in a different block, behind a constant condition, or after a \`break\`/in a second loop — trace whether it actually executes.`,
].join('\n');

/**
 * The code the judge sees: the FULL enclosing function (capped), with C/C++
 * comments stripped (so benchmark giveaway labels never reach the model). Shared
 * with the control-plane judge via @cleak/common; this path keeps its historical
 * ±(6,5)-line fallback window and omits line-number prefixes.
 */
function sourceSnippet(bundle: LeakBundle): string {
  const src = readFileSafe(bundle.candidate.file_path);
  if (!src) return '(source unavailable)';
  return enclosingFunctionSnippet(src, bundle.candidate.line_number || 1, {
    fallbackBefore: THRESHOLDS.snippetFallbackBefore,
    fallbackAfter: THRESHOLDS.snippetFallbackAfter,
  });
}

function summarizeStatic(ctx: Record<string, any> | undefined): string {
  if (!ctx || Object.keys(ctx).length === 0) return '  (no static context)';
  const lines: string[] = [];

  // Ownership-explicit summary (highest-value artifact).
  const own = ctx.ownershipSummary;
  if (own) {
    const carrier =
      own.ownershipCarrier?.kind === 'return_value'
        ? 'returned to caller'
        : own.ownershipCarrier?.kind === 'parameter'
          ? `consumed via parameter '${own.ownershipCarrier.name}'`
          : 'none';
    lines.push(`  - Ownership: role=${own.role}; ownership carrier=${carrier} (${own.rationale})`);
  } else {
    lines.push(`  - Ownership: ${ctx.ownership?.ownershipType ?? 'unknown'}`);
  }

  // Alloc→free pairing table.
  const pairs = (ctx.allocFreePairs || []) as any[];
  if (pairs.length) {
    lines.push('  - Alloc→free pairing:');
    for (const p of pairs.slice(0, THRESHOLDS.maxAllocFreePairsShown)) {
      const freed = p.freeLine != null ? `free@${p.freeLine}` : 'UNPAIRED';
      const newVar = p.bindsToNewVariable ? '' : ' [not a new var]';
      lines.push(`      ${p.variable}: ${p.allocCall}@${p.allocLine} → ${freed} (${p.status})${newVar}`);
    }
  } else {
    lines.push(`  - Has explicit free: ${ctx.hasExplicitFree === true} · Allocations: ${(ctx.allocations || []).length} · Frees: ${(ctx.frees || []).length}`);
  }

  // Feasible leak-path narratives.
  const leakPaths = (ctx.feasibleLeakPaths || []) as any[];
  if (leakPaths.length) {
    lines.push('  - Feasible leak paths:');
    for (const lp of leakPaths.slice(0, THRESHOLDS.maxFeasibleLeakPathsShown)) {
      lines.push(`      • ${lp.narrative} (risk: ${lp.leakRisk})`);
    }
  } else {
    lines.push(`  - Early returns: ${ctx.earlyReturnCount ?? 0} · Leaky exit paths: ${ctx.leakyExitPaths ?? 0}`);
  }

  return lines.join('\n');
}

function summarizeEvidence(bundle: LeakBundle): string {
  if (bundle.evidence.length === 0) return '  (none)';
  const anyLeak = bundle.evidence.some((e) => evidenceIndicatesLeak(e));
  const lines = bundle.evidence.map((e) => {
    const kind = e.leakKind ? ` ${e.leakKind}` : '';
    const site = e.allocSite ? ` @ ${e.allocSite.file}:${e.allocSite.line}` : '';
    const link =
      e.correlatedToCandidate
        ? ' — LINKED to this candidate'
        : e.correlationMethod === 'file_only'
          ? ' — same file, different site'
          : '';
    const clean = evidenceIndicatesLeak(e) ? '' : ' — CLEAN (no leak reported here)';
    return `  - ${e.tool}:${kind} ${e.bytes_lost ?? 0} bytes / ${e.blocks_lost ?? 0} blocks${e.function_name ? ` in ${e.function_name}` : ''}${site}${link}${clean}`;
  });
  // A dynamic run happened but flagged no leak here → strong exculpatory signal.
  if (!anyLeak) {
    lines.unshift('  NOTE: a sanitizer/valgrind run exercised this allocation and reported NO leak — strong evidence this is NOT a leak.');
  }
  return lines.join('\n');
}

export interface ParsedVerdict {
  verdict: string;
  confidence: number;
  explanation: string;
  evidence: string[];
}

/** Shape we accept from the model before the verdict-string check. */
const VerdictResponseSchema = z.object({
  verdict: z.string(),
  confidence: z.number().optional(),
  explanation: z.string().optional(),
  evidence: z.array(z.unknown()).optional(),
});

/**
 * Parse the model's JSON verdict. Returns a discriminated result so the caller can
 * LOG *why* a verdict was unusable instead of silently degrading to the heuristic
 * (the failure mode this hardening targets). Tolerates a JSON object embedded in
 * surrounding prose; validates the shape with Zod, then checks the verdict string.
 */
export function parseVerdict(text: string): { ok: true; value: ParsedVerdict } | { ok: false; reason: string } {
  const raw = text?.trim() ?? '';
  if (!raw) return { ok: false, reason: 'empty model response' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, reason: 'no JSON object in response' };
    try {
      json = JSON.parse(m[0]);
    } catch {
      return { ok: false, reason: 'malformed JSON in response' };
    }
  }
  const parsed = VerdictResponseSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `schema mismatch: ${parsed.error.issues[0]?.message ?? 'invalid object'}` };
  }
  const obj = parsed.data;
  if (!isLeakVerdictString(obj.verdict)) {
    return { ok: false, reason: `unknown verdict "${obj.verdict}"` };
  }
  const confidence = typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0.5;
  return {
    ok: true,
    value: {
      verdict: obj.verdict,
      confidence,
      explanation: typeof obj.explanation === 'string' ? obj.explanation : '',
      evidence: Array.isArray(obj.evidence) ? obj.evidence.map(String) : [],
    },
  };
}

/**
 * Judge one bundle with the LLM. Returns an enriched VerdictResult, or null if the
 * model call/parse failed (the caller keeps the heuristic verdict in that case).
 */
export async function judgeBundleWithLlm(
  bundle: LeakBundle,
  staticContext: Record<string, any> | undefined,
  callModel: CallModel,
  signal?: AbortSignal,
  temperature?: number,
  /** Reports WHY the LLM verdict was unusable (so the silent heuristic fallback is
   * visible). Called with a short reason on a call error or an unparseable verdict. */
  onNotice?: (reason: string) => void,
): Promise<VerdictResult | null> {
  const c = bundle.candidate;
  const user = [
    `ALLOCATION SITE: ${c.function_name || '?'}() at ${c.file_path}:${c.line_number} (${c.allocation_type || 'alloc'})`,
    ``,
    'CODE (context around the allocation):',
    '```c',
    sourceSnippet(bundle),
    '```',
    ``,
    'STATIC ANALYSIS CONTEXT:',
    summarizeStatic(staticContext),
    ``,
    `DYNAMIC EVIDENCE (${bundle.evidence.length}):`,
    summarizeEvidence(bundle),
    ``,
    'Return your JSON verdict.',
  ].join('\n');

  let resp;
  try {
    resp = await callModel({ systemPrompt: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }], tools: [], signal, temperature });
  } catch (err: any) {
    onNotice?.(`judge ${c.file_path}:${c.line_number} — model call failed (${err?.message ?? err}); keeping heuristic`);
    return null;
  }
  const parsed = parseVerdict(resp.text ?? '');
  if (!parsed.ok) {
    onNotice?.(`judge ${c.file_path}:${c.line_number} — ${parsed.reason}; keeping heuristic`);
    return null;
  }
  const base: VerdictResult = {
    verdict: parsed.value.verdict as InvestigationVerdict,
    confidence: parsed.value.confidence,
    explanation: parsed.value.explanation,
    evidence: parsed.value.evidence,
    tool: ToolKind.LLM,
  };
  return enrichLeakVerdict(bundle, staticContext ?? {}, base);
}

/** A bundle is borderline (worth an LLM second opinion) when the heuristic is unsure. */
export function isBorderline(verdict: VerdictResult): boolean {
  const v = verdict.verdict;
  if (v === InvestigationVerdict.LIKELY_LEAK || v === InvestigationVerdict.UNCERTAIN) return true;
  // confident confirmed / false-positive → skip the LLM
  return verdict.confidence >= THRESHOLDS.borderlineLow && verdict.confidence <= THRESHOLDS.borderlineHigh;
}

/**
 * When the staged judge should take an LLM (consensus) second opinion. Beyond the
 * heuristic being unsure (`isBorderline`), escalate when STATIC and DYNAMIC evidence
 * point different ways — that is exactly where a single deterministic pass is least
 * reliable. This matters most with dynamic analysis ON: runtime evidence makes the
 * heuristic MORE confident, which would otherwise push a verdict OUT of the borderline
 * band and silently BYPASS the consensus (observed: with `--dynamic selective` the
 * consensus stopped firing and false positives rose). Routing conflicts to the LLM
 * re-engages the consensus precisely when it is most needed. With dynamic OFF a bundle
 * has no evidence, so only `isBorderline` applies — the dyn-off path is unchanged.
 */
export function shouldEscalate(bundle: LeakBundle): boolean {
  const v = bundle.verdict;
  if (!v) return false;
  if (isBorderline(v)) return true;

  const flagged = v.verdict === InvestigationVerdict.CONFIRMED_LEAK || v.verdict === InvestigationVerdict.LIKELY_LEAK;
  const correlatedLeak = bundle.evidence.some((e) => e.correlatedToCandidate === true && evidenceIndicatesLeak(e));
  const anyLeakEvidence = bundle.evidence.some((e) => evidenceIndicatesLeak(e));
  // Prefer the explicit deterministic coverage; fall back to evidence (back-compat).
  const dynamicRanClean =
    bundle.dynamicCoverage === 'exercised_clean' ||
    (bundle.dynamicCoverage === undefined && bundle.evidence.length > 0 && !anyLeakEvidence);

  if (flagged) {
    // A confident flag whose runtime support is only an UN-correlated leak (coarse
    // correlation — the main false-positive source), or that a CLEAN dynamic run
    // contradicts, deserves reconciliation by the LLM.
    if (anyLeakEvidence && !correlatedLeak) return true;
    if (dynamicRanClean) return true;
  } else {
    // The heuristic did NOT flag, but a correlated runtime leak says it should.
    if (correlatedLeak) return true;
  }

  // Confident-vs-confident static↔verdict contradiction: a non-borderline verdict
  // that the fused STATIC evidence opposes is exactly the case the consensus exists
  // to reconcile, yet (being confident) it would otherwise bypass the LLM.
  const fusion = deriveFusion(bundle);
  if (flagged && fusion.static === 'clean') return true; // flags a leak, but ownership is handed out
  if (!flagged && fusion.static === 'leak') return true; // clears it, but static says unpaired/reachable
  return false;
}
