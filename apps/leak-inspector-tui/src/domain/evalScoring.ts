/**
 * Ground-truth scoring: compare a scan's snapshot findings against a labeled
 * benchmark case to produce classification samples (the basis for Precision /
 * Recall / F1). Scoring is by ENCLOSING FUNCTION — a flagged leak in a `bad`
 * (flaw) function is a true positive; a flagged leak in a `good*` (clean)
 * function is a false positive; an unflagged real flaw is a false negative; an
 * unflagged clean site is a true negative. Works whether the case ships explicit
 * function labels (preferred) or relies on Juliet's bad/good naming convention.
 */

import type { Sample } from '@mcpvul/common/analysis/metrics';
import { LEAK_POSITIVE_VERDICTS } from '@mcpvul/common/analysis/judge-shared';

export interface LabeledFlaw {
  file?: string;
  /** Function that contains the leak (e.g. `CWE401_..._bad`, `make_buffer`). */
  function: string;
  line?: number;
  cwe?: string;
}

export interface CleanSite {
  file?: string;
  /** Function known to be leak-free (allocates+frees, or no leak). */
  function: string;
  /** Allocation line, for cases where one function holds both clean + leaking sites. */
  line?: number;
}

export interface LabeledCase {
  id: string;
  repo_path: string;
  build_command?: string;
  /** Positive ground truth — real leaks. */
  flaws?: LabeledFlaw[];
  /** Negative ground truth — clean functions that must NOT be flagged. */
  clean?: CleanSite[];
  /** v1 back-compat: aggregate count only (no per-function labels). */
  expected_leak_count?: number;
  /** Benchmark metadata for breakdowns. */
  cwe?: string;
  flowVariant?: string;
  functionalVariant?: string;
}

export interface LabeledManifest {
  schema_version: string;
  name?: string;
  cases: LabeledCase[];
}

/** A snapshot finding (subset of fields we score on; read from snapshot.json). */
export interface SnapshotFinding {
  function?: string;
  file?: string;
  line?: number;
  verdict?: string;
  confidence?: number;
}

/** A verdict counts as "flagged as a leak" (the positive prediction). */
export function isFlagged(verdict?: string): boolean {
  return !!verdict && LEAK_POSITIVE_VERDICTS.has(verdict);
}

/** True when this case carries per-function ground truth (v2), not just a count. */
export function hasGroundTruth(c: LabeledCase): boolean {
  return (c.flaws?.length ?? 0) > 0 || (c.clean?.length ?? 0) > 0;
}

function normalize(fn: string): string {
  return fn.trim().toLowerCase();
}

/**
 * `long` ends with `short` at an identifier boundary — i.e. the char preceding
 * the suffix is a name separator (`_`/`:`/`.`), not a letter. This makes the
 * match tolerant of Juliet testcase prefixes (`CWE401_…__malloc_char_01_bad`
 * vs `…_bad`) WITHOUT the false hits a bare `endsWith` produces (`domain`
 * spuriously matching `main`, `badge_alloc` matching `bad`).
 */
function suffixAtBoundary(long: string, short: string): boolean {
  if (long.length <= short.length || !long.endsWith(short)) return false;
  const sep = long[long.length - short.length - 1];
  return sep === '_' || sep === ':' || sep === '.';
}

/** Tolerant function-name match (handles testcase-prefixed Juliet names). */
function sameFunction(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  return x === y || suffixAtBoundary(x, y) || suffixAtBoundary(y, x);
}

function baseName(p?: string): string {
  return (p ?? '').split('/').pop() ?? '';
}

/** A finding's file matches a label's file (basename), or the label omits a file. */
function fileMatches(finding: SnapshotFinding, labelFile?: string): boolean {
  if (!labelFile) return true;
  const a = baseName(finding.file);
  return a === labelFile || a.endsWith(labelFile) || labelFile.endsWith(a);
}

/** Exact line match (allocations can be 1 line apart, so no tolerance) on the same file. */
function lineMatches(finding: SnapshotFinding, label: { file?: string; line?: number }): boolean {
  return label.line != null && finding.line === label.line && fileMatches(finding, label.file);
}

/** Classify a finding's enclosing function as a flaw (bad), clean (good), or unknown. */
export function classifyFunction(fn: string, c: LabeledCase): 'bad' | 'good' | 'unknown' {
  if (!fn) return 'unknown';
  if ((c.flaws ?? []).some((f) => sameFunction(f.function, fn))) return 'bad';
  if ((c.clean ?? []).some((g) => sameFunction(g.function, fn))) return 'good';
  // Juliet naming convention fallback (goodG2B / goodB2G / *_bad).
  const lower = normalize(fn);
  if (lower.includes('good')) return 'good';
  if (lower.includes('bad')) return 'bad';
  return 'unknown';
}

/**
 * "Line mode" — every label carries a line, so allocations are scored by exact
 * line (used by the hand-labeled demo corpus, where one function can hold both a
 * leaking and a non-leaking allocation). Otherwise we're in "function mode" (the
 * Juliet bad/good naming convention), where any allocation in a flaw function is
 * the flaw and any in a good function is clean.
 */
function isLineMode(c: LabeledCase): boolean {
  if (!hasGroundTruth(c)) return false;
  return (c.flaws ?? []).every((f) => f.line != null) && (c.clean ?? []).every((g) => g.line != null);
}

/**
 * Classify one finding: exact line match against a labeled flaw/clean site
 * first; in function mode also fall back to enclosing-function naming. In line
 * mode an unlabeled allocation is `unknown` (excluded) rather than guessed.
 */
export function classifyFinding(f: SnapshotFinding, c: LabeledCase): 'bad' | 'good' | 'unknown' {
  for (const flaw of c.flaws ?? []) if (lineMatches(f, flaw)) return 'bad';
  for (const clean of c.clean ?? []) if (lineMatches(f, clean)) return 'good';
  return isLineMode(c) ? 'unknown' : classifyFunction(f.function ?? '', c);
}

/** Does any finding cover this flaw (by exact line; by function in function mode)? */
function flawCovered(findings: SnapshotFinding[], flaw: LabeledFlaw, c: LabeledCase): boolean {
  const lineMode = isLineMode(c);
  return findings.some((f) => lineMatches(f, flaw) || (!lineMode && sameFunction(f.function ?? '', flaw.function)));
}

/**
 * The ground-truth SITE a finding is scored against: its exact allocation line
 * in line mode, else its enclosing function. Findings that share a site collapse
 * to one sample so a candidate the scanner reports twice (or once per tool)
 * can't inflate TP/FP — one real flaw is one confusion-matrix entry.
 */
function siteKey(f: SnapshotFinding, lineMode: boolean): string {
  return lineMode ? `${baseName(f.file)}:${f.line ?? '?'}` : normalize(f.function ?? '');
}

interface SiteAgg {
  cls: 'bad' | 'good';
  /** Flagged if ANY finding at this site was flagged. */
  flagged: boolean;
  confidence?: number;
}

/**
 * Produce classification samples for one case, ONE per ground-truth site (not
 * one per finding): findings are grouped by enclosing function (function mode)
 * or allocation line (line mode), so duplicate/multi-tool findings on the same
 * site count once. Any labeled flaw that produced NO finding (discovery missed
 * it entirely) is added as a false negative so recall isn't inflated.
 */
export function scoreCase(findings: SnapshotFinding[], c: LabeledCase): Sample[] {
  const lineMode = isLineMode(c);
  const sites = new Map<string, SiteAgg>();
  for (const f of findings) {
    const cls = classifyFinding(f, c);
    if (cls === 'unknown') continue;
    const key = siteKey(f, lineMode);
    const flagged = isFlagged(f.verdict);
    const prev = sites.get(key);
    if (!prev) {
      sites.set(key, { cls, flagged, confidence: f.confidence });
    } else if (flagged && !prev.flagged) {
      // A flagged finding wins the prediction and carries its confidence.
      prev.flagged = true;
      prev.confidence = f.confidence;
    }
  }

  const samples: Sample[] = [];
  for (const site of sites.values()) {
    samples.push({ actual: site.cls === 'bad', predicted: site.flagged, confidence: site.confidence });
  }
  for (const flaw of c.flaws ?? []) {
    if (!flawCovered(findings, flaw, c)) samples.push({ actual: true, predicted: false, confidence: 0 }); // missed → FN
  }
  return samples;
}
