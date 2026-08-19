/**
 * Single-bundle LLM judge for the workflow's hybrid judging stage. The heuristic
 * judge scores every bundle from the (now-populated) static context + evidence;
 * only BORDERLINE bundles are escalated here for an LLM verdict. We ask the model
 * for a compact JSON verdict and run it through the shared `enrichLeakVerdict` so
 * it still ships a root cause + source-anchored repair diff.
 */

import { z } from 'zod';
import { readFileSafe } from './fileWalk';
import type { FileContentCache } from './fileContentCache';
import { THRESHOLDS } from './thresholds';
import { enrichLeakVerdict, judgeHeuristically } from '@cleak/common/analysis/heuristic-judge';
import {
  deriveFusion,
  combineVerdicts,
  isDecisionLocked,
  type ConsensusConfig,
  type ConsensusVerdict,
  type EvidenceFusion,
} from '@cleak/common/analysis/consensus-judge';
import {
  enclosingFunctionSnippet,
  isLeakVerdictString,
  evidenceIndicatesLeak,
  isQuotaExhaustedError,
  QuotaExhaustedError,
} from '@cleak/common/analysis/judge-shared';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '@cleak/common/types';
import type { CallModel } from '@cleak/agent-core';

/** Calibration rules shared verbatim by the single-bundle and batch judge
 * prompts — a single source of truth so the two never drift apart. */
const CALIBRATION_RULES = [
  `Calibrate using the EVIDENCE, in this priority order:`,
  `- A runtime leak (sanitizer/valgrind) whose allocation site is LINKED to this candidate is decisive → confirmed_leak (confidence ≥ 0.9). Weight by leak kind: definitely_lost / asan_leak ⇒ decisive; possibly_lost ⇒ weak corroboration; still_reachable ⇒ usually benign, lean false_positive.`,
  `- A runtime finding in the SAME FILE but a DIFFERENT site (not linked) is weak — do not treat it as proof for this allocation. still_reachable with no other evidence → false_positive.`,
  `- A CLEAN sanitizer/valgrind run is only strong exculpation when it EXERCISED THIS ALLOCATION (the evidence entry is CORRELATED to this candidate). A clean run that merely covered the FILE (a different site, or a run with no correlated entry) is weak — it does NOT clear this allocation.`,
  `- UNPAIRED alloc→free at the allocation site is a STRONG leak signal. When the static pairing table marks an allocation 'UNPAIRED' (no free found in this function), do NOT dismiss it with an ownership-transfer narrative (returned / stored in a struct / handed to a callback) UNLESS the code snippet actually shows the pointer being returned, stored, or handed off. When the static pairing is UNPAIRED and the only counter-evidence is an ambiguous clean dynamic run, default to likely_leak — not false_positive.`,
  `- Ownership is decisive for false positives: if the allocation is RETURNED to the caller or its pointer is HANDED OFF to a sink/callback/another function (ownership transferred), freeing it is NOT this function's job. When ownership is transferred AND no runtime leak is linked to THIS allocation, answer likely_false_positive or false_positive — do NOT flag it just because you cannot see the free inside this snippet. An UNPAIRED alloc→free with a reachable leak path and NO ownership transfer → confirmed_leak (≥ 0.85).`,
  `- PATH-SENSITIVE leak: an allocation freed on the main/success path but NOT on an error or early-return path (e.g. \`if (err) return NULL;\` or \`goto fail;\` before the free) IS a leak — confirmed_leak — EVEN IF the value is returned or added to a structure on the success path. Ownership transferring on success does not cover the error path that loses the object. If the static context lists the allocation as freed "on some paths only" (conditional) or names it on a reachable un-freed exit path, treat that as decisive.`,
  `- PARAMETER-ownership leak (allocation_type 'parameter_ownership'): when a function frees a pointer PARAMETER on some paths (taking ownership from the caller, e.g. cJSON's \`merge_patch\` does \`cJSON_Delete(target)\`) but a reachable branch returns WITHOUT freeing it, that branch leaks the parameter — confirmed_leak. The parameter has no allocation site in the function; judge it by the conditional free + the reachable un-freed exit.`,
  `- Freed on all paths / static-global → false_positive (high confidence). Use uncertain only when the evidence is genuinely insufficient.`,
  `- Control flow is concrete, not hypothetical: a constant or scaffolding global such as \`if(1)\`/\`if(0)\` or \`globalReturnsTrue()\` does NOT change between two checks in the SAME function — \`if(1)\` always runs and \`if(0)\` is dead code. If the buffer is freed under the same condition it was allocated (or in the \`else\` of a constant \`if\`), it IS freed. Do NOT call a leak just because the \`free()\` sits in a different block, behind a constant condition, or after a \`break\`/in a second loop — trace whether it actually executes.`,
];

// Exported so judgeVerdictCache.ts can hash the LIVE prompt text (not a
// hand-maintained version counter) into its cache key — any edit to this
// prompt then automatically invalidates stale cached verdicts, with no risk
// of someone forgetting to bump a version number.
export const SYSTEM_PROMPT = [
  `You are an expert C/C++ memory-leak analyst. Decide whether ONE allocation is a real leak, using the code, static context, and any runtime evidence provided.`,
  `Respond with a JSON object ONLY (no prose), in this exact shape:`,
  `{"verdict": "confirmed_leak | likely_leak | uncertain | likely_false_positive | false_positive", "confidence": 0.0-1.0, "explanation": "...", "evidence": ["..."]}`,
  ...CALIBRATION_RULES,
].join('\n');

/** Batch variant of SYSTEM_PROMPT — same calibration rules (CALIBRATION_RULES,
 * shared verbatim), different framing/response-format header for judging N
 * independent candidates in one call. See `judgeBundlesBatched`. */
export const BATCH_SYSTEM_PROMPT = [
  `You are an expert C/C++ memory-leak analyst. You will be given MULTIPLE independent candidate allocations from the SAME project. Decide whether EACH is a real leak, using its own code/static context/evidence — judge every candidate independently; do not let one candidate's verdict influence another's.`,
  `Respond with a SINGLE JSON ARRAY ONLY (no prose, no markdown code fences) — one array containing exactly one object per candidate, in the SAME ORDER as the candidates below, each object shaped exactly:`,
  `{"id": "<candidate id from the prompt>", "verdict": "confirmed_leak | likely_leak | uncertain | likely_false_positive | false_positive", "confidence": 0.0-1.0, "explanation": "...", "evidence": ["..."]}`,
  `Example response shape for exactly 2 candidates (the whole response is ONE array literal, wrapped in [ ] with a comma between items — NEVER emit one bare object per line/NDJSON, and NEVER omit the enclosing [ ] brackets):`,
  `[{"id": "candidate-1-id", "verdict": "confirmed_leak", "confidence": 0.9, "explanation": "...", "evidence": ["..."]}, {"id": "candidate-2-id", "verdict": "false_positive", "confidence": 0.8, "explanation": "...", "evidence": ["..."]}]`,
  ...CALIBRATION_RULES,
].join('\n');

/**
 * The code the judge sees: the FULL enclosing function (capped), with C/C++
 * comments stripped (so benchmark giveaway labels never reach the model). Shared
 * with the control-plane judge via @cleak/common; this path keeps its historical
 * ±(6,5)-line fallback window and omits line-number prefixes.
 */
function sourceSnippet(bundle: LeakBundle, fileCache?: FileContentCache): string {
  const src = fileCache ? fileCache.read(bundle.candidate.file_path) : readFileSafe(bundle.candidate.file_path);
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
  // A dynamic run cleared THIS allocation (correlated) → meaningful exculpation.
  // A clean run that only covered the file (uncorrelated/different site) is weak
  // and must NOT be presented as "this allocation was exercised clean" — the judge
  // over-weighted that wording and exculpated UNPAIRED static allocations (task-5
  // class-(b) hardening). Only correlated clean entries claim the allocation itself.
  if (!anyLeak && bundle.evidence.some((e) => e.correlatedToCandidate === true && !evidenceIndicatesLeak(e))) {
    lines.unshift('  NOTE: this allocation was exercised and reported NO leak — correlated evidence it is NOT a leak.');
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

/** Shared validation core for both the single-bundle and batch parse paths —
 * one source of truth for "is this object a usable verdict", so the two
 * response formats (one object vs. an array of these) can never drift apart
 * on what counts as valid. */
function validateVerdictObject(obj: unknown): { ok: true; value: ParsedVerdict } | { ok: false; reason: string } {
  const parsed = VerdictResponseSchema.safeParse(obj);
  if (!parsed.success) {
    return { ok: false, reason: `schema mismatch: ${parsed.error.issues[0]?.message ?? 'invalid object'}` };
  }
  const d = parsed.data;
  if (!isLeakVerdictString(d.verdict)) {
    return { ok: false, reason: `unknown verdict "${d.verdict}"` };
  }
  const confidence = typeof d.confidence === 'number' ? Math.min(1, Math.max(0, d.confidence)) : 0.5;
  return {
    ok: true,
    value: {
      verdict: d.verdict,
      confidence,
      explanation: typeof d.explanation === 'string' ? d.explanation : '',
      evidence: Array.isArray(d.evidence) ? d.evidence.map(String) : [],
    },
  };
}

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
  return validateVerdictObject(json);
}

const BatchVerdictItemSchema = VerdictResponseSchema.extend({ id: z.string().optional() });

/**
 * Scan raw text for top-level `{...}` objects, brace-depth-aware (so quoted
 * braces/commas inside string values never confuse it), and JSON.parse each
 * one independently. Used as a fallback when the model doesn't wrap its
 * response in `[...]` as instructed — observed for real (a non-default
 * provider returned one JSON object per line, i.e. NDJSON, instead of a JSON
 * array); this recovers those objects regardless of whether they're
 * newline-separated, comma-separated, or pretty-printed across multiple
 * lines, without requiring a specific separator.
 */
function extractJsonObjects(raw: string): unknown[] {
  const objs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          objs.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          // skip a malformed top-level object, keep scanning for the rest
        }
        start = -1;
      }
    }
  }
  return objs;
}

/**
 * Parse a batch judge response — a JSON array of per-candidate verdicts —
 * tolerantly: a malformed/missing item for ONE candidate must never cost the
 * other N-1 their real verdicts (mirrors `parseVerdict`'s own "log why, don't
 * silently degrade" discipline, extended to per-item granularity). Matches
 * each response item back to `expectedIds` by its `id` field when present
 * (robust to the model reordering the array), falling back to positional
 * order otherwise. Every id in `expectedIds` gets an entry in the returned
 * Map — callers keep the heuristic verdict for any `{ ok: false }` entry.
 */
export function parseBatchVerdicts(
  text: string,
  expectedIds: string[],
): Map<string, { ok: true; value: ParsedVerdict } | { ok: false; reason: string }> {
  const results = new Map<string, { ok: true; value: ParsedVerdict } | { ok: false; reason: string }>();
  const raw = text?.trim() ?? '';
  let arr: unknown;
  if (raw) {
    try {
      arr = JSON.parse(raw);
    } catch {
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) {
        try {
          arr = JSON.parse(m[0]);
        } catch {
          arr = undefined;
        }
      }
    }
  }
  if (!Array.isArray(arr) && raw) {
    // Fallback: the model ignored the "wrap in a JSON array" instruction and
    // emitted one object per candidate with no enclosing brackets (NDJSON or
    // similar) — recover the individual objects instead of discarding every
    // verdict in the batch.
    const objs = extractJsonObjects(raw);
    if (objs.length > 0) arr = objs;
  }
  if (!Array.isArray(arr)) {
    const reason = raw ? 'no JSON array in batch response' : 'empty model response';
    for (const id of expectedIds) results.set(id, { ok: false, reason });
    return results;
  }
  for (let i = 0; i < expectedIds.length; i++) {
    const id = expectedIds[i];
    const item = arr.find((x) => x && typeof x === 'object' && (x as { id?: unknown }).id === id) ?? arr[i];
    if (item === undefined) {
      results.set(id, { ok: false, reason: 'missing from batch response' });
      continue;
    }
    const parsedItem = BatchVerdictItemSchema.safeParse(item);
    results.set(id, parsedItem.success ? validateVerdictObject(parsedItem.data) : { ok: false, reason: `schema mismatch: ${parsedItem.error.issues[0]?.message ?? 'invalid object'}` });
  }
  return results;
}

/**
 * Build the exact user-message text sent to the judge for one bundle. Exported —
 * not just for `judgeBundleWithLlm` below — so `judgeVerdictCache.ts` can hash
 * this SAME string into its cache key instead of separately re-deriving "what
 * fields affect the prompt" (which would risk drifting out of sync with this
 * function and silently under-keying the cache).
 */
export function buildJudgeUserMessage(
  bundle: LeakBundle,
  staticContext: Record<string, any> | undefined,
  projectNotes: string[] | undefined,
  fileCache?: FileContentCache,
): string {
  const c = bundle.candidate;
  const notes = (projectNotes ?? []).filter(Boolean);
  return [
    `ALLOCATION SITE: ${c.function_name || '?'}() at ${c.file_path}:${c.line_number} (${c.allocation_type || 'alloc'})`,
    ``,
    'CODE (context around the allocation):',
    '```c',
    sourceSnippet(bundle, fileCache),
    '```',
    ``,
    'STATIC ANALYSIS CONTEXT:',
    summarizeStatic(staticContext),
    ``,
    `DYNAMIC EVIDENCE (${bundle.evidence.length}):`,
    summarizeEvidence(bundle),
    ...(notes.length
      ? ['', 'PROJECT OWNERSHIP CONVENTIONS (respect these — they encode how THIS project manages memory):', ...notes.map((n) => `- ${n}`)]
      : []),
    ``,
    'Return your JSON verdict.',
  ].join('\n');
}

/** Candidates per batched judge call (single-shot AND consensus-round paths).
 * Large enough to meaningfully amortize the ~960-token fixed system-prompt tax
 * (measured this session: 738 candidates × individual calls for one real
 * case); small enough to avoid two known LLM failure modes — attention
 * dilution over long lists ("lost in the middle") and a truncated/malformed
 * batch response losing many verdicts at once instead of one. Not
 * user-configurable yet — revisit once real-world batching numbers are in
 * (see the batch-judging plan). */
export const JUDGE_BATCH_SIZE = 12;

export interface BatchJudgeItem {
  bundle: LeakBundle;
  staticContext: Record<string, any> | undefined;
}

/**
 * Build the user message for a BATCH judge call — N candidates concatenated
 * into one prompt, each in its own numbered/id-tagged block (reusing the same
 * `sourceSnippet`/`summarizeStatic`/`summarizeEvidence` helpers unchanged —
 * batching is purely a wire-format change, the per-candidate content is
 * identical to what `buildJudgeUserMessage` sends for a single bundle).
 */
export function buildBatchUserMessage(items: BatchJudgeItem[], projectNotes: string[] | undefined, fileCache?: FileContentCache): string {
  const notes = (projectNotes ?? []).filter(Boolean);
  const blocks = items.map((item, i) => {
    const c = item.bundle.candidate;
    return [
      `── CANDIDATE ${i + 1} (id: ${item.bundle.bundleId}) ──`,
      `ALLOCATION SITE: ${c.function_name || '?'}() at ${c.file_path}:${c.line_number} (${c.allocation_type || 'alloc'})`,
      ``,
      'CODE (context around the allocation):',
      '```c',
      sourceSnippet(item.bundle, fileCache),
      '```',
      ``,
      'STATIC ANALYSIS CONTEXT:',
      summarizeStatic(item.staticContext),
      ``,
      `DYNAMIC EVIDENCE (${item.bundle.evidence.length}):`,
      summarizeEvidence(item.bundle),
    ].join('\n');
  });
  return [
    ...blocks,
    ...(notes.length
      ? ['', 'PROJECT OWNERSHIP CONVENTIONS (respect these for ALL candidates above — they encode how THIS project manages memory):', ...notes.map((n) => `- ${n}`)]
      : []),
    ``,
    `Return your JSON array of ${items.length} verdict(s), in order, one per candidate above.`,
  ].join('\n\n');
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
  /** Project-specific ownership conventions (LLM-discovered) the verdict must respect. */
  projectNotes?: string[],
  /** Reports the model token usage of THIS judge call (tokens are spent on any call,
   * parseable or not) so the harness can count judge cost — it was previously dropped
   * (only the agentic Stage A/B loops accumulated usage). */
  onUsage?: (u: { inputTokens: number; outputTokens: number }) => void,
  /** Per-scan file-content memo cache (perf P0-1): the judge's source snippet read
   * shares the scan's single-read cache instead of hitting the disk again. */
  fileCache?: FileContentCache,
): Promise<VerdictResult | null> {
  const c = bundle.candidate;
  const user = buildJudgeUserMessage(bundle, staticContext, projectNotes, fileCache);

  let resp;
  try {
    resp = await callModel({ systemPrompt: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }], tools: [], signal, temperature });
  } catch (err: unknown) {
    // Quota/rate-limit exhaustion is never a legitimate "keep the heuristic"
    // situation — every subsequent call will fail identically until the quota
    // resets, so silently substituting the heuristic verdict would mislabel a
    // degraded run as LLM-assisted. Let the caller decide what to do (abort vs.
    // opt-in fallback), instead of deciding here.
    if (isQuotaExhaustedError(err)) throw new QuotaExhaustedError(err);
    const msg = err instanceof Error ? err.message : String(err);
    onNotice?.(`judge ${c.file_path}:${c.line_number} — model call failed (${msg}); keeping heuristic`);
    return null;
  }
  if (resp.usage) onUsage?.({ inputTokens: resp.usage.inputTokens ?? 0, outputTokens: resp.usage.outputTokens ?? 0 });
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
  const hardened = applyStaticUnpairedGuard(bundle, staticContext, base);
  return enrichLeakVerdict(bundle, staticContext ?? {}, hardened);
}

/**
 * Judge MULTIPLE bundles in ONE LLM call — the fixed ~960-token system-prompt/
 * instruction overhead is paid once instead of once per candidate (batch
 * prompting — see the cost investigation this session that measured 738
 * escalated candidates / 334+ individual judge calls for a single real-world
 * case, confirming call-count multiplication, not per-call bloat, dominates
 * real-corpus cost). Returns a Map from bundleId to an enriched VerdictResult;
 * a bundleId ABSENT from the map means the batch response didn't include a
 * usable verdict for it — the caller keeps that bundle's existing heuristic
 * verdict, exactly as `judgeBundleWithLlm`'s per-bundle fallback already does.
 * One bad/missing item in the batch never costs the other N-1 their real verdicts.
 */
export async function judgeBundlesBatched(
  items: BatchJudgeItem[],
  callModel: CallModel,
  signal?: AbortSignal,
  temperature?: number,
  /** Reports WHY the batch (or one item within it) was unusable. */
  onNotice?: (reason: string) => void,
  projectNotes?: string[],
  onUsage?: (u: { inputTokens: number; outputTokens: number }) => void,
  fileCache?: FileContentCache,
): Promise<Map<string, VerdictResult>> {
  const out = new Map<string, VerdictResult>();
  if (items.length === 0) return out;
  const ids = items.map((i) => i.bundle.bundleId);
  const user = buildBatchUserMessage(items, projectNotes, fileCache);

  let resp;
  try {
    resp = await callModel({ systemPrompt: BATCH_SYSTEM_PROMPT, messages: [{ role: 'user', content: user }], tools: [], signal, temperature });
  } catch (err: unknown) {
    if (isQuotaExhaustedError(err)) throw new QuotaExhaustedError(err);
    const msg = err instanceof Error ? err.message : String(err);
    onNotice?.(`batch judge (${items.length} candidates) — model call failed (${msg}); keeping heuristic for all`);
    return out;
  }
  if (resp.usage) onUsage?.({ inputTokens: resp.usage.inputTokens ?? 0, outputTokens: resp.usage.outputTokens ?? 0 });

  const parsedMap = parseBatchVerdicts(resp.text ?? '', ids);
  for (const item of items) {
    const id = item.bundle.bundleId;
    const parsed = parsedMap.get(id);
    if (!parsed || !parsed.ok) {
      onNotice?.(`batch judge ${item.bundle.candidate.file_path}:${item.bundle.candidate.line_number} — ${parsed?.reason ?? 'missing from batch response'}; keeping heuristic`);
      continue;
    }
    const base: VerdictResult = {
      verdict: parsed.value.verdict as InvestigationVerdict,
      confidence: parsed.value.confidence,
      explanation: parsed.value.explanation,
      evidence: parsed.value.evidence,
      tool: ToolKind.LLM,
    };
    const hardened = applyStaticUnpairedGuard(item.bundle, item.staticContext, base);
    out.set(id, enrichLeakVerdict(item.bundle, item.staticContext ?? {}, hardened));
  }
  return out;
}

/**
 * Consensus judging for MULTIPLE bundles, batched by ROUND instead of by
 * bundle: sample #k for every still-active bundle is drawn in one (or a few,
 * if the active set exceeds `JUDGE_BATCH_SIZE`) `judgeBundlesBatched` calls,
 * repeated for up to `cfg.n` rounds — instead of each bundle independently
 * making its own `cfg.n` single-bundle calls. Draws exactly the same samples,
 * in the same order, as today's per-bundle `judgeByConsensus` loop would —
 * batching only changes HOW each round's samples are transported, not how
 * many are drawn or when early-stop fires (`isDecisionLocked` is evaluated
 * per-bundle each round, identically to `sampleWithEarlyStop`'s own check).
 * Combination (`combineVerdicts`/`judgeHeuristically`) is reused unchanged —
 * this function only replaces the SAMPLING loop, never the decision logic.
 */
export async function judgeBundlesConsensusBatched(
  items: BatchJudgeItem[],
  callModel: CallModel,
  cfg: ConsensusConfig,
  signal?: AbortSignal,
  onNotice?: (reason: string) => void,
  projectNotes?: string[],
  onUsage?: (u: { inputTokens: number; outputTokens: number }) => void,
  fileCache?: FileContentCache,
): Promise<Map<string, ConsensusVerdict>> {
  const out = new Map<string, ConsensusVerdict>();
  if (items.length === 0) return out;
  const n = Math.max(1, Math.floor(cfg.n));

  const perBundleSamples = new Map<string, VerdictResult[]>(items.map((i) => [i.bundle.bundleId, []]));
  const perBundleFusion = new Map<string, EvidenceFusion>(items.map((i) => [i.bundle.bundleId, deriveFusion(i.bundle)]));

  let active = items;
  for (let round = 0; round < n && active.length > 0; round++) {
    for (let i = 0; i < active.length; i += JUDGE_BATCH_SIZE) {
      const chunk = active.slice(i, i + JUDGE_BATCH_SIZE);
      // Reused as-is — a consensus round IS "draw one more sample for these
      // bundles," the exact same shape as the single-shot batch call, just at
      // the consensus temperature instead of the deterministic judge one.
      const results = await judgeBundlesBatched(chunk, callModel, signal, cfg.temperature, onNotice, projectNotes, onUsage, fileCache);
      for (const item of chunk) {
        const sample = results.get(item.bundle.bundleId);
        // Absent from the batch response (malformed/missing item — already
        // logged by judgeBundlesBatched) → this round yields no sample for
        // that bundle, exactly like a failed sampleJudge() call today
        // (combineVerdicts already filters `v != null`).
        if (sample) perBundleSamples.get(item.bundle.bundleId)!.push(sample);
      }
    }
    if (cfg.earlyStop) {
      const remaining = n - (round + 1);
      active = active.filter((item) => {
        const id = item.bundle.bundleId;
        return !isDecisionLocked(perBundleSamples.get(id)!, remaining, cfg, perBundleFusion.get(id)!);
      });
    }
  }

  for (const item of items) {
    const id = item.bundle.bundleId;
    const heuristic = judgeHeuristically(item.bundle, item.staticContext);
    out.set(id, combineVerdicts(perBundleSamples.get(id)!, heuristic, perBundleFusion.get(id)!, cfg));
  }
  return out;
}

/**
 * Task-5 class-(b) judge hardening: a confident LLM exculpation (false_positive /
 * likely_false_positive) must NOT survive when the static evidence marks the
 * allocation's alloc→free pair UNPAIRED at the site AND no ownership transfer is
 * evidenced AND the dynamic run did not CONFIRM a leak. This is exactly the
 * LAMeD class-(b) shape (cJSON_Duplicate `newitem->string`, curl `xoauth@519`):
 * the model rationalized an ownership transfer the static context does not show,
 * over an UNPAIRED pairing — producing a false negative. The guard demotes the
 * verdict to `uncertain` (it never invents a leak — it only refuses a confident
 * false_positive the evidence contradicts). Prompt-hardening (the UNPAIRED rule
 * in SYSTEM_PROMPT) fixes the model; this guard fixes the residual case where
 * the model still answers false_positive.
 */
function applyStaticUnpairedGuard(
  bundle: LeakBundle,
  staticContext: Record<string, any> | undefined,
  llmVerdict: VerdictResult,
): VerdictResult {
  const v = llmVerdict.verdict;
  if (v !== InvestigationVerdict.FALSE_POSITIVE && v !== InvestigationVerdict.LIKELY_FALSE_POSITIVE) return llmVerdict;

  const dynamicConfirmedLeak =
    bundle.dynamicCoverage === 'exercised_leak' || bundle.evidence.some((e) => e.correlatedToCandidate === true && evidenceIndicatesLeak(e));

  // A correlated dynamic leak is the strongest evidence class there is — it must
  // never be silently overridden by an LLM false_positive, WHETHER OR NOT static
  // enrichment succeeded for this candidate. Checked first, independent of
  // `staticContext`, because the static-based check below used to be the only
  // guard and bailed out entirely (`if (!staticContext) return llmVerdict`)
  // whenever functionSummary/pathConstraints failed — silently letting a
  // dynamically-confirmed leak get dismissed on exactly the candidates with the
  // weakest static evidence.
  if (dynamicConfirmedLeak) {
    return {
      ...llmVerdict,
      verdict: InvestigationVerdict.UNCERTAIN,
      confidence: Math.min(llmVerdict.confidence ?? 0.5, 0.5),
      explanation: `[correlated dynamic leak not exculpable by an LLM false_positive] ${llmVerdict.explanation ?? ''}`.trim(),
    };
  }

  if (!staticContext) return llmVerdict;

  const pairs = (staticContext.allocFreePairs ?? []) as Array<Record<string, any>>;
  const unpaired = pairs.some((p) => p.status === 'unpaired');
  if (!unpaired) return llmVerdict;

  const carrier = (staticContext.ownershipSummary ?? staticContext.ownership)?.ownershipCarrier;
  const ownershipTransferred = !!carrier && typeof carrier.kind === 'string' && carrier.kind !== 'none';
  if (ownershipTransferred) return llmVerdict;

  return {
    ...llmVerdict,
    verdict: InvestigationVerdict.UNCERTAIN,
    confidence: Math.min(llmVerdict.confidence ?? 0.5, 0.5),
    explanation: `[unpaired static alloc→free not exculpable by an ambiguous clean run] ${llmVerdict.explanation ?? ''}`.trim(),
  };
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
