/**
 * Framework-free helpers for enriching dynamic (Valgrind / ASan / LSan) findings
 * into the richer `LeakEvidence` shape the LLM judge consumes, and for
 * cross-correlating a dynamic allocation site back to the static candidate it
 * belongs to.
 *
 * Both orchestration paths reuse this: the web orchestrator
 * (scan-orchestrator.service) and the TUI `record_evidence` tool. Derivation is
 * authoritative on the CONSUMER side so it works even when structured fields are
 * stripped crossing gRPC (only `stack_trace` string + `allocation_type` survive
 * the proto) — we recover `allocStack`/`allocSite`/`leakKind` from those.
 *
 * Imported via the sub-path `@cleak/common/analysis/dynamic-evidence`.
 */
import { createHash } from 'crypto';
import {
  CorrelationMethod,
  DynamicLeakKind,
  LeakCandidate,
  LeakEvidence,
  StackFrameRef,
} from '../types/leak-schema.types';

/** Paths / functions that indicate a non-user (allocator / libc) frame. */
const LIBRARY_FILE_RE = /\/usr\/|\/libc|\/libgcc|\/lib\/|libstdc\+\+|vg_replace_malloc|<unknown>/i;
const ALLOCATOR_FN_RE =
  /^(malloc|calloc|realloc|free|operator new|operator delete|_Zn[wa]|__libc_|__GI_|memalign|posix_memalign|strdup)/i;

export function isUserFrame(file: string | null, fn: string | null): boolean {
  if (!file) return false;
  if (LIBRARY_FILE_RE.test(file)) return false;
  if (fn && ALLOCATOR_FN_RE.test(fn)) return false;
  return true;
}

/** Normalize a raw tool leak kind (Valgrind kind or ASan label) to the taxonomy. */
export function normalizeLeakKind(
  rawKind: string | undefined,
  tool: string,
): DynamicLeakKind {
  const k = (rawKind || '').toLowerCase().replace(/[\s_-]/g, '');
  if (k.includes('definitelylost')) return DynamicLeakKind.DEFINITELY_LOST;
  if (k.includes('indirectlylost')) return DynamicLeakKind.INDIRECTLY_LOST;
  if (k.includes('possiblylost')) return DynamicLeakKind.POSSIBLY_LOST;
  if (k.includes('stillreachable')) return DynamicLeakKind.STILL_REACHABLE;
  if (tool === 'asan' || tool === 'lsan' || k.includes('leak')) {
    return DynamicLeakKind.ASAN_LEAK;
  }
  return DynamicLeakKind.OTHER;
}

/** Parse a joined "func at file:line" stack string into structured frames. */
export function parseStackTrace(stackTrace: string | undefined): StackFrameRef[] {
  if (!stackTrace) return [];
  const frames: StackFrameRef[] = [];
  for (const rawLine of stackTrace.split('\n')) {
    const t = rawLine.trim();
    if (!t) continue;
    // "func at file:line"  (line optional)
    const m = t.match(/^(.*?)\s+at\s+(.*?)(?::(\d+))?$/);
    if (!m) continue;
    const fn = m[1] && m[1] !== 'null' ? m[1] : null;
    const file = m[2] && m[2] !== 'null' && m[2] !== '' ? m[2] : null;
    const line = m[3] ? parseInt(m[3], 10) : null;
    frames.push({
      function: fn,
      file,
      line: Number.isNaN(line as number) ? null : line,
      isUserFrame: isUserFrame(file, fn),
    });
  }
  return frames;
}

/** Convert a normalizer/parser StackFrame[] into StackFrameRef[] with user flags. */
export function framesToStackRefs(
  stack: { function?: string | null; file?: string | null; line?: number | null }[] | undefined,
): StackFrameRef[] {
  return (stack || []).map((s) => ({
    function: s.function ?? null,
    file: s.file ?? null,
    line: s.line ?? null,
    isUserFrame: isUserFrame(s.file ?? null, s.function ?? null),
  }));
}

/** The first user frame (or first frame with a file) — the allocation site. */
export function firstUserFrame(
  frames: StackFrameRef[],
): { file: string; line: number; function: string } | undefined {
  const f = frames.find((fr) => fr.isUserFrame && fr.file) || frames.find((fr) => fr.file);
  if (!f || !f.file) return undefined;
  return { file: f.file, line: f.line ?? 0, function: f.function ?? '' };
}

export function computeEvidenceSignature(evidence: LeakEvidence): string {
  const site = evidence.allocSite;
  const parts = [
    evidence.tool,
    evidence.leakKind || '',
    site?.function || evidence.function_name || '',
    site?.file || evidence.file_path || '',
    String(site?.line ?? evidence.line_number ?? ''),
  ];
  return createHash('sha1').update(parts.join('|'), 'utf-8').digest('hex');
}

const CORR_RANK: Record<CorrelationMethod, number> = {
  file_line_exact: 4,
  file_line_near: 3,
  function_match: 2,
  file_only: 1,
  none: 0,
};

export function correlationRank(method: CorrelationMethod): number {
  return CORR_RANK[method];
}

/** A finding is "correlated" to a candidate only at function-match strength or better. */
export function isCorrelated(method: CorrelationMethod): boolean {
  return CORR_RANK[method] >= CORR_RANK.function_match;
}

/** A path matches another iff equal OR a suffix on a PATH-SEGMENT boundary. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/** True when `long` ends with `short` AND the break is a directory boundary. */
function isSuffixPath(long: string, short: string): boolean {
  if (long.length <= short.length || !long.endsWith(short)) return false;
  return long[long.length - short.length - 1] === '/';
}

/**
 * True when two file paths plausibly denote the same file: equal, or one is a
 * suffix of the other on a path-segment boundary (so `src/foo.c` ~ `foo.c`, but
 * `barfoo.c` does NOT match `foo.c`). The old raw `endsWith` matched any string
 * suffix and cross-linked unrelated files that shared a filename tail — a real
 * precision bug that mis-attributed dynamic findings on multi-file repos.
 */
function fileMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na === nb) return true;
  // basename guard: a suffix match must at least agree on the file name itself.
  if (na.split('/').pop() !== nb.split('/').pop()) return false;
  return isSuffixPath(na, nb) || isSuffixPath(nb, na);
}

/** libc/C++ allocator names collapsed to a canonical family for cross-checking. */
const ALLOC_FN_RE =
  /^(x?malloc|x?calloc|x?realloc|x?strn?dup|g_malloc\w*|g_realloc\w*|memalign|posix_memalign|aligned_alloc|operator new|_Zn[wa])/i;

const ALLOCATOR_FAMILY: Record<string, string> = {
  malloc: 'malloc', xmalloc: 'malloc', g_malloc: 'malloc',
  calloc: 'calloc', xcalloc: 'calloc',
  realloc: 'realloc', xrealloc: 'realloc', g_realloc: 'realloc',
  strdup: 'strdup', xstrdup: 'strdup', strndup: 'strdup',
  memalign: 'aligned', posix_memalign: 'aligned', aligned_alloc: 'aligned',
  new: 'new', 'operator new': 'new',
};

/**
 * Canonical allocator family for an allocation-type string or stack frame name.
 * libc families collapse (`xmalloc`→`malloc`); a custom allocator keeps its own
 * name as its family so two *different* custom allocators don't match. `null`
 * when nothing allocator-like is recognizable (signal simply isn't applied).
 */
export function allocatorFamily(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/\(.*$/, '').replace(/\s+/g, ' ').trim();
  if (!n) return null;
  if (ALLOCATOR_FAMILY[n]) return ALLOCATOR_FAMILY[n];
  for (const key of Object.keys(ALLOCATOR_FAMILY)) {
    if (n === key || n.startsWith(key)) return ALLOCATOR_FAMILY[key];
  }
  if (/(^|_)alloc/.test(n) || /alloc(\w+)?$/.test(n)) return n; // custom allocator
  return null;
}

/** The allocator frame of a finding's backtrace (first frame that allocates). */
export function evidenceAllocatorName(evidence: LeakEvidence): string | null {
  for (const fr of evidence.allocStack || []) {
    if (fr.function && ALLOC_FN_RE.test(fr.function)) return fr.function;
  }
  return null;
}

const NEAR_BASE_CONFIDENCE = 0.75;
const METHOD_BASE_CONFIDENCE: Record<CorrelationMethod, number> = {
  file_line_exact: 1.0,
  file_line_near: NEAR_BASE_CONFIDENCE,
  function_match: 0.5,
  file_only: 0.25,
  none: 0,
};

export interface EvidenceCorrelation {
  correlationMethod: CorrelationMethod;
  correlationDistanceLines?: number;
  correlatedToCandidate: boolean;
  /** Graded 0..1 link strength (method + line distance + allocator agreement). */
  correlationConfidence: number;
}

/**
 * Best correlation between a dynamic finding's candidate alloc sites and a
 * static candidate. Considers `allocSite`, user frames of `allocStack`, and the
 * evidence's own reported location, and returns a graded `correlationConfidence`
 * (method + line distance + allocator-family agreement) so a caller can break
 * ties when a finding could attach to more than one nearby candidate.
 */
export function correlateEvidence(
  evidence: LeakEvidence,
  candidate: LeakCandidate,
  nearThreshold = 5,
): EvidenceCorrelation {
  const sites: { file: string; line: number; function: string }[] = [];
  if (evidence.allocSite) sites.push(evidence.allocSite);
  for (const fr of evidence.allocStack || []) {
    if (fr.isUserFrame && fr.file) {
      sites.push({ file: fr.file, line: fr.line ?? 0, function: fr.function ?? '' });
    }
  }
  if (evidence.file_path) {
    sites.push({
      file: evidence.file_path,
      line: evidence.line_number,
      function: evidence.function_name,
    });
  }

  let bestMethod: CorrelationMethod = 'none';
  let bestDist: number | undefined;

  const consider = (method: CorrelationMethod, dist?: number) => {
    if (CORR_RANK[method] > CORR_RANK[bestMethod]) {
      bestMethod = method;
      bestDist = dist;
    } else if (
      CORR_RANK[method] === CORR_RANK[bestMethod] &&
      dist != null &&
      (bestDist == null || dist < bestDist)
    ) {
      bestDist = dist; // same method, nearer site — keep the closer distance
    }
  };

  for (const site of sites) {
    const sameFn =
      !!site.function &&
      !!candidate.function_name &&
      site.function === candidate.function_name;
    if (site.file && fileMatches(site.file, candidate.file_path)) {
      const dist = Math.abs(site.line - candidate.line_number);
      if (dist === 0) consider('file_line_exact', dist);
      else if (dist <= nearThreshold) consider('file_line_near', dist);
      else if (sameFn) consider('function_match', dist);
      else consider('file_only', dist);
    } else if (sameFn) {
      consider('function_match');
    }
  }

  // ── Graded confidence: decay `file_line_near` with distance, then nudge by
  // allocator-family agreement (a calloc finding attaching to a malloc candidate
  // 4 lines away is weaker than a same-allocator match). Never flips
  // `correlatedToCandidate` — that stays the method-rank decision. ──
  // Compare by RANK, not the literal union: `bestMethod` is reassigned only inside
  // the `consider` closure, so the compiler narrows it back to `'none'` and would
  // reject a direct `=== 'file_line_near'` comparison.
  const rank = CORR_RANK[bestMethod];
  let confidence = METHOD_BASE_CONFIDENCE[bestMethod];
  if (rank === CORR_RANK.file_line_near && bestDist != null) {
    confidence = Math.max(0.5, NEAR_BASE_CONFIDENCE - 0.05 * bestDist);
  }
  if (rank > CORR_RANK.none) {
    const candFam = allocatorFamily(candidate.allocation_type);
    const evFam = allocatorFamily(evidenceAllocatorName(evidence));
    if (candFam && evFam) {
      confidence = candFam === evFam ? Math.min(1, confidence + 0.05) : Math.max(0, confidence - 0.15);
    }
  }

  return {
    correlationMethod: bestMethod,
    correlationDistanceLines: bestDist,
    correlatedToCandidate: isCorrelated(bestMethod),
    correlationConfidence: Number(confidence.toFixed(3)),
  };
}

/**
 * Fill in the structured/derived fields of a dynamic LeakEvidence from whatever
 * is present (structured fields preferred, else parsed from `stack_trace` +
 * `rawLeakKind`). Does NOT correlate — caller does that against a candidate.
 */
export function deriveDynamicFields(
  evidence: LeakEvidence,
  opts?: { rawLeakKind?: string; rawStack?: { function?: string | null; file?: string | null; line?: number | null }[] },
): LeakEvidence {
  const allocStack =
    evidence.allocStack && evidence.allocStack.length
      ? evidence.allocStack
      : opts?.rawStack && opts.rawStack.length
        ? framesToStackRefs(opts.rawStack)
        : parseStackTrace(evidence.stack_trace);
  const allocSite = evidence.allocSite ?? firstUserFrame(allocStack);
  const leakKind = evidence.leakKind ?? normalizeLeakKind(opts?.rawLeakKind, evidence.tool);
  const enriched: LeakEvidence = { ...evidence, allocStack, allocSite, leakKind };
  enriched.signature = evidence.signature ?? computeEvidenceSignature(enriched);
  return enriched;
}
