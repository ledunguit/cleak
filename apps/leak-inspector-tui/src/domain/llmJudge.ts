/**
 * Single-bundle LLM judge for the workflow's hybrid judging stage. The heuristic
 * judge scores every bundle from the (now-populated) static context + evidence;
 * only BORDERLINE bundles are escalated here for an LLM verdict. We ask the model
 * for a compact JSON verdict and run it through the shared `enrichLeakVerdict` so
 * it still ships a root cause + source-anchored repair diff.
 */

import { readFileSafe } from './fileWalk';
import { enrichLeakVerdict } from '@mcpvul/common/analysis/heuristic-judge';
import { enclosingFunctionSnippet, isLeakVerdictString } from '@mcpvul/common/analysis/judge-shared';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '@mcpvul/common/types';
import type { CallModel } from '@mcpvul/agent-core';

const SYSTEM_PROMPT = [
  `You are an expert C/C++ memory-leak analyst. Decide whether ONE allocation is a real leak, using the code, static context, and any runtime evidence provided.`,
  `Respond with a JSON object ONLY (no prose), in this exact shape:`,
  `{"verdict": "confirmed_leak | likely_leak | uncertain | likely_false_positive | false_positive", "confidence": 0.0-1.0, "explanation": "...", "evidence": ["..."]}`,
  `Calibrate using the EVIDENCE, in this priority order:`,
  `- A runtime leak (sanitizer/valgrind) whose allocation site is LINKED to this candidate is decisive → confirmed_leak (confidence ≥ 0.9). Weight by leak kind: definitely_lost / asan_leak ⇒ decisive; possibly_lost ⇒ weak corroboration; still_reachable ⇒ usually benign, lean false_positive.`,
  `- A runtime finding in the SAME FILE but a DIFFERENT site (not linked) is weak — do not treat it as proof for this allocation. still_reachable with no other evidence → false_positive.`,
  `- Ownership is decisive for false positives: if the allocation is RETURNED to the caller or its pointer is HANDED OFF to a sink/callback/another function (ownership transferred), freeing it is NOT this function's job. When ownership is transferred AND no runtime leak is linked to THIS allocation, answer likely_false_positive or false_positive — do NOT flag it just because you cannot see the free inside this snippet. An UNPAIRED alloc→free with a reachable leak path and NO ownership transfer → confirmed_leak (≥ 0.85).`,
  `- Freed on all paths / static-global → false_positive (high confidence). Use uncertain only when the evidence is genuinely insufficient.`,
].join('\n');

/**
 * The code the judge sees: the FULL enclosing function (capped), with C/C++
 * comments stripped (so benchmark giveaway labels never reach the model). Shared
 * with the control-plane judge via @mcpvul/common; this path keeps its historical
 * ±(6,5)-line fallback window and omits line-number prefixes.
 */
function sourceSnippet(bundle: LeakBundle): string {
  const src = readFileSafe(bundle.candidate.file_path);
  if (!src) return '(source unavailable)';
  return enclosingFunctionSnippet(src, bundle.candidate.line_number || 1, { fallbackBefore: 6, fallbackAfter: 5 });
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
    for (const p of pairs.slice(0, 12)) {
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
    for (const lp of leakPaths.slice(0, 5)) {
      lines.push(`      • ${lp.narrative} (risk: ${lp.leakRisk})`);
    }
  } else {
    lines.push(`  - Early returns: ${ctx.earlyReturnCount ?? 0} · Leaky exit paths: ${ctx.leakyExitPaths ?? 0}`);
  }

  return lines.join('\n');
}

function summarizeEvidence(bundle: LeakBundle): string {
  if (bundle.evidence.length === 0) return '  (none)';
  return bundle.evidence
    .map((e) => {
      const kind = e.leakKind ? ` ${e.leakKind}` : '';
      const site = e.allocSite ? ` @ ${e.allocSite.file}:${e.allocSite.line}` : '';
      const link =
        e.correlatedToCandidate
          ? ' — LINKED to this candidate'
          : e.correlationMethod === 'file_only'
            ? ' — same file, different site'
            : '';
      return `  - ${e.tool}:${kind} ${e.bytes_lost ?? 0} bytes / ${e.blocks_lost ?? 0} blocks${e.function_name ? ` in ${e.function_name}` : ''}${site}${link}`;
    })
    .join('\n');
}

/** Parse the model's JSON verdict; returns null if unusable. */
function parseVerdict(text: string): { verdict: string; confidence: number; explanation: string; evidence: string[] } | null {
  let raw = text?.trim() ?? '';
  if (!raw) return null;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!obj || !isLeakVerdictString(obj.verdict)) return null;
  const confidence = typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0.5;
  return {
    verdict: obj.verdict,
    confidence,
    explanation: typeof obj.explanation === 'string' ? obj.explanation : '',
    evidence: Array.isArray(obj.evidence) ? obj.evidence.map(String) : [],
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
  } catch {
    return null;
  }
  const parsed = parseVerdict(resp.text ?? '');
  if (!parsed) return null;
  const base: VerdictResult = {
    verdict: parsed.verdict as InvestigationVerdict,
    confidence: parsed.confidence,
    explanation: parsed.explanation,
    evidence: parsed.evidence,
    tool: ToolKind.LLM,
  };
  return enrichLeakVerdict(bundle, staticContext ?? {}, base);
}

/** A bundle is borderline (worth an LLM second opinion) when the heuristic is unsure. */
export function isBorderline(verdict: VerdictResult): boolean {
  const v = verdict.verdict;
  if (v === InvestigationVerdict.LIKELY_LEAK || v === InvestigationVerdict.UNCERTAIN) return true;
  // confident confirmed / false-positive → skip the LLM
  return verdict.confidence >= 0.35 && verdict.confidence <= 0.7;
}
