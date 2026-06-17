/**
 * Shared judge primitives used by BOTH judge paths (control-plane
 * judge.service.ts and leak-inspector-tui llmJudge.ts) so the verdict taxonomy,
 * the benchmark-fairness comment stripping, and the enclosing-function snippet
 * extraction have a single source of truth instead of drifting copy-paste. The
 * system prompts themselves intentionally differ (the control-plane prompt asks
 * for an inline structured rootCause/repairDiff; the TUI prompt asks for a
 * compact verdict and synthesizes those afterward via enrichLeakVerdict), so
 * only the genuinely shared, behavior-defining helpers live here.
 */

import { findEnclosingFunction } from './heuristic-leak-analysis';

/** The five investigation verdicts, as wire strings (matches InvestigationVerdict). */
export const LEAK_VERDICT_STRINGS = [
  'confirmed_leak',
  'likely_leak',
  'uncertain',
  'likely_false_positive',
  'false_positive',
] as const;

export type LeakVerdictString = (typeof LEAK_VERDICT_STRINGS)[number];

const VERDICT_SET: ReadonlySet<string> = new Set(LEAK_VERDICT_STRINGS);

/** True when `v` is one of the five valid verdict strings. */
export function isLeakVerdictString(v: unknown): v is LeakVerdictString {
  return typeof v === 'string' && VERDICT_SET.has(v);
}

/** The verdicts that count as "flagged as a leak" (a positive prediction). */
export const LEAK_POSITIVE_VERDICTS: ReadonlySet<string> = new Set(['confirmed_leak', 'likely_leak']);

/** Dynamic leak kinds that denote a real leak (NOT `still_reachable`, which is benign). */
const LEAK_LEAK_KINDS: ReadonlySet<string> = new Set([
  'definitely_lost',
  'indirectly_lost',
  'possibly_lost',
  'asan_leak',
]);
/** Severities that denote a real leak finding (a clean run reports `info`). */
const LEAK_SEVERITIES: ReadonlySet<string> = new Set(['medium', 'high', 'critical']);

/**
 * True when a dynamic evidence entry denotes an ACTUAL leak, as opposed to a clean
 * or benign run record. Juliet `good*` variants run cleanly under LSan/Valgrind and
 * produce an `info` / no-`leakKind` entry — that is NOT evidence of a leak and must
 * never push a verdict toward one (the old judge mis-scored such entries as +0.15).
 * `still_reachable` (memory reachable at exit) is benign and likewise excluded.
 */
export function evidenceIndicatesLeak(e: {
  leakKind?: string | null;
  severity?: string | null;
  bytes_lost?: number;
  blocks_lost?: number;
}): boolean {
  if (e.leakKind === 'still_reachable') return false;
  if (e.leakKind && LEAK_LEAK_KINDS.has(e.leakKind)) return true;
  if (e.severity && LEAK_SEVERITIES.has(String(e.severity).toLowerCase())) return true;
  return (e.bytes_lost ?? 0) > 0 || (e.blocks_lost ?? 0) > 0;
}

/**
 * Strip C/C++ comments (newline-preserving) so benchmark giveaway labels — Juliet's
 * `/* POTENTIAL FLAW *​/`, `GoodSource`/`GoodSink` — never reach the judge. Letting
 * the model read them skews BOTH recall (it cheats on `bad`) and precision (a clean
 * function carrying a leftover FLAW comment gets flagged). Reasoning is on code, not labels.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

export const LEAK_SNIPPET_MAX_LINES = 120;

export interface SnippetOptions {
  /** Cap on snippet length; a larger enclosing function is windowed around the alloc. */
  maxLines?: number;
  /** Prefix each line with its 1-based line number (helps the judge cite lines). */
  withLineNumbers?: boolean;
  /** When no enclosing function is found, how many lines before/after the alloc to show. */
  fallbackBefore?: number;
  fallbackAfter?: number;
}

/**
 * The code the judge should see: the FULL enclosing function (capped), not a
 * ±5-line window — a window around the alloc routinely cuts off the `free()`
 * lower in the function and makes the model "confirm" leaks in clean code.
 * Comments are stripped first. Callers pass their own fallback window / line-number
 * preference so this single implementation reproduces each path's exact output.
 */
export function enclosingFunctionSnippet(source: string, lineNumber: number, opts: SnippetOptions = {}): string {
  const { maxLines = LEAK_SNIPPET_MAX_LINES, withLineNumbers = false, fallbackBefore = 6, fallbackAfter = 5 } = opts;
  const lines = stripComments(source).split('\n');
  const line = lineNumber || 1;
  const idx = Math.min(Math.max(line - 1, 0), lines.length - 1);
  const fn = findEnclosingFunction(lines, idx);
  let start: number;
  let end: number;
  if (fn) {
    start = Math.max(0, fn.startIdx - 2); // include the signature above the brace
    end = Math.min(lines.length, fn.endIdx + 1);
    if (end - start > maxLines) {
      // Function too large — keep a window inside it, centered on the allocation.
      start = Math.max(start, idx - Math.floor(maxLines / 2));
      end = Math.min(end, start + maxLines);
    }
  } else {
    start = Math.max(0, line - fallbackBefore);
    end = Math.min(lines.length, line + fallbackAfter);
  }
  const slice = lines.slice(start, end);
  return withLineNumbers ? slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n') : slice.join('\n');
}
