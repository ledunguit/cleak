/**
 * Single-bundle LLM judge for the workflow's hybrid judging stage. The heuristic
 * judge scores every bundle from the (now-populated) static context + evidence;
 * only BORDERLINE bundles are escalated here for an LLM verdict. We ask the model
 * for a compact JSON verdict and run it through the shared `enrichLeakVerdict` so
 * it still ships a root cause + source-anchored repair diff.
 */

import { readFileSafe } from './fileWalk';
import { enrichLeakVerdict } from '@mcpvul/common/analysis/heuristic-judge';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '@mcpvul/common/types';
import type { CallModel } from '@mcpvul/agent-core';

const VERDICTS = new Set([
  'confirmed_leak',
  'likely_leak',
  'uncertain',
  'likely_false_positive',
  'false_positive',
]);

const SYSTEM_PROMPT = [
  `You are an expert C/C++ memory-leak analyst. Decide whether ONE allocation is a real leak, using the code, static context, and any runtime evidence provided.`,
  `Respond with a JSON object ONLY (no prose), in this exact shape:`,
  `{"verdict": "confirmed_leak | likely_leak | uncertain | likely_false_positive | false_positive", "confidence": 0.0-1.0, "explanation": "...", "evidence": ["..."]}`,
  `Calibrate: a runtime sanitizer/valgrind leak, or a path that allocates and never frees before exit, or a pointer overwritten without freeing the old value → confirmed_leak (confidence ≥ 0.85; ≥ 0.9 with runtime proof). Freed on all paths / ownership transferred to the caller / static-global → false_positive (high confidence). Use uncertain only if the evidence is genuinely insufficient.`,
].join('\n');

function sourceSnippet(bundle: LeakBundle): string {
  const src = readFileSafe(bundle.candidate.file_path);
  if (!src) return '(source unavailable)';
  const lines = src.split('\n');
  const line = bundle.candidate.line_number || 1;
  const start = Math.max(0, line - 6);
  const end = Math.min(lines.length, line + 5);
  return lines.slice(start, end).join('\n');
}

function summarizeStatic(ctx: Record<string, any> | undefined): string {
  if (!ctx || Object.keys(ctx).length === 0) return '  (no static context)';
  return [
    `  - Has explicit free: ${ctx.hasExplicitFree === true}`,
    `  - Allocations: ${(ctx.allocations || []).length} · Frees: ${(ctx.frees || []).length}`,
    `  - Feasible paths: ${(ctx.feasiblePaths || []).length}`,
    `  - Early returns: ${ctx.earlyReturnCount ?? 0} · Leaky exit paths: ${ctx.leakyExitPaths ?? 0}`,
    `  - Ownership: ${ctx.ownership?.ownershipType ?? 'unknown'}`,
  ].join('\n');
}

function summarizeEvidence(bundle: LeakBundle): string {
  if (bundle.evidence.length === 0) return '  (none)';
  return bundle.evidence
    .map((e) => `  - ${e.tool}: ${e.bytes_lost ?? 0} bytes lost${e.function_name ? ` in ${e.function_name}` : ''}`)
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
  if (!obj || typeof obj.verdict !== 'string' || !VERDICTS.has(obj.verdict)) return null;
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
    resp = await callModel({ systemPrompt: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }], tools: [], signal });
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
