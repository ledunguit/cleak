/**
 * heuristic-judge — the LLM-free verdict synthesizer, shared so the control
 * plane and the leak-inspector-tui produce byte-identical verdicts in no_llm
 * mode (and identical finalization of any un-verdicted bundle in llm_assisted
 * mode). Scores lexical static context + dynamic evidence + the source-level
 * structural analysis into a verdict, and guarantees every leak verdict ships a
 * root cause and an applicable, source-anchored repair diff.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  InvestigationVerdict,
  ToolKind,
  type LeakBundle,
  type VerdictResult,
  type RepairDiff,
} from '../types';
import { analyzeLeakHeuristically } from './heuristic-leak-analysis';
import { evidenceIndicatesLeak } from './judge-shared';

/**
 * Verdict score thresholds. These are the FROZEN benchmark defaults — the evaluation
 * ALWAYS uses these, so the reported Juliet/LAMeD numbers are an honest, fixed-policy
 * measure (no per-project tuning leaks into the benchmark). A production scan MAY pass a
 * bounded per-project override (see domain/judgeTuner.ts) to adapt to a project's
 * ownership style; the thesis reports both default and tuned numbers. Named here (not
 * inlined) so the calibration is explicit + auditable rather than magic constants.
 */
export interface VerdictThresholds {
  /** score ≥ this → confirmed_leak */
  confirmed: number;
  /** score ≥ this → likely_leak (else uncertain) */
  likely: number;
}
export const JUDGE_VERDICT_THRESHOLDS: VerdictThresholds = { confirmed: 0.7, likely: 0.4 };

export function readFullFile(filePath: string): string | null {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Heuristic (LLM-free) verdict from lexical context + dynamic evidence + structural analysis. */
export function judgeHeuristically(
  bundle: LeakBundle,
  staticContext?: Record<string, any>,
  /** Bounded per-project override (production only). Omitted in the benchmark ⇒ the
   * frozen JUDGE_VERDICT_THRESHOLDS are used ⇒ eval stays deterministic. */
  thresholds: VerdictThresholds = JUDGE_VERDICT_THRESHOLDS,
): VerdictResult {
  const hasStaticFree = staticContext?.hasExplicitFree === true;
  const hasStaticAllocation = (staticContext?.allocations || []).length > 0;
  const hasFeasiblePaths = (staticContext?.feasiblePaths || []).length > 0;
  const hasOwnershipIssue = staticContext?.ownership?.ownershipType === 'malloc_without_free';
  const earlyReturnCount: number = staticContext?.earlyReturnCount || 0;
  const location = `${bundle.candidate.file_path}:${bundle.candidate.line_number}`;
  // Prefer the rich, typed static evidence; fall back to the loose context keys
  // so no_llm runs against pre-existing reports stay comparable.
  const se = bundle.staticEvidence;

  let score = 0;
  const reasons: string[] = [];

  // Source-level structural analysis up front: among other things it determines
  // whether the function frees the candidate at all, which gates the lexical
  // suspicion terms below (so a function that demonstrably frees isn't flagged).
  const analysis = analyzeLeakHeuristically(bundle, staticContext, readFullFile(bundle.candidate.file_path));

  // ── Dynamic evidence: correlation- and kind-aware, not a flat credit. We take
  // the single strongest finding's contribution rather than stacking many. Only an
  // ACTUAL leak adds score; a clean/benign run record (Juliet good* under LSan:
  // severity `info`, no leakKind) instead EXONERATES — see `dynamicallyCleared`. ──
  if (bundle.evidence.length > 0) {
    let dyn = 0;
    let dynReason = '';
    for (const e of bundle.evidence) {
      if (!evidenceIndicatesLeak(e)) continue; // clean run / still_reachable — not a leak
      const correlated = e.correlatedToCandidate === true;
      const kind = e.leakKind;
      let c: number;
      if (correlated && (kind === 'definitely_lost' || kind === 'asan_leak' || kind === 'indirectly_lost')) {
        c = 0.5;
      } else if (correlated && kind === 'possibly_lost') {
        c = 0.2;
      } else if (correlated) {
        c = 0.4; // correlated runtime leak, kind unknown
      } else {
        // Uncorrelated (file_only/none) finding — a leak at a DIFFERENT site in the
        // same file is not evidence for THIS allocation. It neither inflates the
        // score nor (below) exonerates. (Was +0.15 — a precision bug.)
        continue;
      }
      if (c > dyn) {
        dyn = c;
        dynReason = `${e.tool} ${kind ?? 'leak'} ${correlated ? 'LINKED to candidate' : '(uncorrelated)'}`;
      }
    }
    if (dyn > 0) {
      score += dyn;
      reasons.push(`runtime evidence: ${dynReason}`);
    }
  }
  // Exoneration is driven by the EXPLICIT, deterministic coverage status — a clean
  // run that genuinely exercised this candidate — NOT inferred from `evidence.length`
  // (which conflates "ran clean" with "never ran"). Fall back to evidence inference
  // only for bundles that predate the field (e.g. the control-plane web path).
  const dynamicallyCleared =
    bundle.dynamicCoverage === 'exercised_clean' ||
    (bundle.dynamicCoverage === undefined &&
      bundle.evidence.length > 0 &&
      bundle.evidence.every((e) => !evidenceIndicatesLeak(e)));

  // ── Alloc→free pairing: an UNPAIRED allocation of the candidate variable. ──
  const candidatePair = (se?.allocFreePairs || []).find(
    (p) => Math.abs(p.allocLine - bundle.candidate.line_number) <= 1,
  );
  if (candidatePair && candidatePair.status === 'unpaired') {
    score += 0.25;
    reasons.push(`alloc of '${candidatePair.variable}' is never freed (unpaired)`);
  } else if (candidatePair && candidatePair.status === 'conditional') {
    score += 0.15;
    reasons.push(`alloc of '${candidatePair.variable}' is freed on some paths only`);
  } else if (!hasStaticFree && hasStaticAllocation && !analysis.freedAnywhereInFunction) {
    score += 0.25;
    reasons.push('no free() found in function for this allocation');
  }

  // ── Feasible (reachable) leak path through the candidate. ──
  const reachableLeakPath = (se?.feasibleLeakPaths || []).some((lp) => lp.reachable && lp.leakRisk !== 'none');
  if (reachableLeakPath) {
    score += 0.2;
    reasons.push('a reachable execution path leaves this allocation un-freed');
  } else if (hasFeasiblePaths) {
    score += 0.2;
    reasons.push('allocation reachable through feasible execution path(s)');
  }

  // ── Clang scan-build corroboration (opt-in `--static-tools scanBuild`): a project-
  // level scan-build leak diagnostic for this candidate is a deterministic second static
  // opinion. scan-build reports at the LEAK SITE (the exit/last-use), not the allocation
  // line, so a pure line window misses it — match primarily by the LEAKED VARIABLE it
  // names (`…pointed to by 'data'`) appearing in the candidate's alloc context, and fall
  // back to a line window. Absent unless scanBuild ran ⇒ never perturbs the default. ──
  const candCtx = `${bundle.candidate.context ?? ''} ${bundle.candidate.allocation_site ?? ''}`;
  const scanBuildHit = (se?.scanBuildDiagnostics || []).some((d) => {
    const leakedVar = /pointed to by '([^']+)'/.exec(d.message)?.[1];
    const varMatch = !!leakedVar && new RegExp(`\\b${leakedVar.replace(/[^\w]/g, '')}\\b`).test(candCtx);
    return varMatch || Math.abs(d.line - bundle.candidate.line_number) <= 2;
  });
  if (scanBuildHit) {
    score += 0.15;
    reasons.push('Clang scan-build reports a leak of this allocation');
  }

  // ── PATH-SENSITIVE leak: the candidate is freed on SOME paths but a reachable exit
  // still loses it — status 'conditional', or the candidate's variable is explicitly
  // `unreconciled` on a reachable leak path. This is the real "missing-free on an
  // error/early-return path" and the dominant REAL-PROJECT leak shape (e.g. cJSON's
  // `cJSON_free(full_pointer)` / `cJSON_Delete(target)` missing on one branch). It is
  // a STRONG signal, and (below) it must NOT be exonerated by the ownership-transfer
  // penalty: a path that LOSES the object is not a path that transfers ownership. ──
  const candidateVar = candidatePair?.variable;
  const candidateUnreconciled = (se?.feasibleLeakPaths || []).some(
    (lp) =>
      lp.reachable &&
      lp.leakRisk !== 'none' &&
      !!candidateVar &&
      (lp.unreconciledAllocations || []).includes(candidateVar),
  );
  const pathSensitiveLeak = (candidatePair?.status === 'conditional' && reachableLeakPath) || candidateUnreconciled;
  if (pathSensitiveLeak) {
    score += 0.15;
    reasons.push('path-sensitive: freed on some paths but a reachable exit leaks this allocation');
  }

  // ── Ownership: allocator that carries no ownership out → likely a local leak. ──
  if (
    se?.ownership &&
    (se.ownership.role === 'allocator' || se.ownership.role === 'both') &&
    se.ownership.ownershipCarrier?.kind === 'none' &&
    !analysis.freedAnywhereInFunction
  ) {
    score += 0.15;
    reasons.push('allocator role with no ownership transfer out of the function');
  } else if (se?.ownership && se.ownership.ownershipCarrier?.kind !== 'none') {
    // Ownership is returned/consumed — this is the caller's (or sink's)
    // responsibility, a strong false-positive signal. Penalize harder when there
    // is NO correlated runtime leak on this candidate (e.g. Juliet good* funcs
    // hand the buffer to a sink and never run dynamically under -DOMITGOOD).
    const correlatedLeak = bundle.evidence.some(
      (e) => e.correlatedToCandidate === true && evidenceIndicatesLeak(e),
    );
    // Do NOT exonerate when there's a path-sensitive leak: ownership may transfer on
    // the success path, but the object is LOST on the error path — that leak is real.
    if (pathSensitiveLeak) {
      reasons.push(`ownership transferred on the success path, but a reachable exit still leaks this allocation`);
    } else {
      score -= correlatedLeak ? 0.1 : 0.25;
      reasons.push(`ownership transferred (${se.ownership.ownershipCarrier?.kind}) — likely the caller's to free`);
    }
  } else if (hasOwnershipIssue) {
    score += 0.15;
    reasons.push('ownership convention: malloc_without_free');
  }

  if ((staticContext?.earlyReturnCount || 0) > 0 && hasStaticAllocation) {
    score += 0.1;
    reasons.push(`function has ${earlyReturnCount} early return(s) that may skip cleanup`);
  }

  if (bundle.candidate.confidence === 'high') {
    score += 0.1;
  }

  // 1-hop interprocedural free: the allocated pointer is handed to a sink that
  // frees it (e.g. Juliet good*→goodSink). Dismiss with confidence so it is NOT
  // flagged and does NOT escalate to the LLM (which can't see the sink in the
  // ±-line snippet). Unless a runtime tool actually reported a leak at this site.
  const correlatedRuntimeLeak = bundle.evidence.some(
    (e) => e.correlatedToCandidate === true && evidenceIndicatesLeak(e),
  );
  if (analysis.freedViaCallee && !correlatedRuntimeLeak) {
    return {
      verdict: InvestigationVerdict.LIKELY_FALSE_POSITIVE,
      confidence: 0.8,
      explanation: `\`${analysis.freedViaCallee.variable}\` is freed in callee \`${analysis.freedViaCallee.callee}()\` — ownership is consumed by the sink, not leaked.`,
      evidence: bundle.evidence.map((e) => `${e.tool}: ${e.function_name}`),
      tool: ToolKind.HEURISTIC,
    };
  }

  if (analysis.structuralLikelihood === 'high') {
    score += 0.5;
    reasons.push(`structural analysis located a missing free (${analysis.patternType})`);
  } else if (analysis.structuralLikelihood === 'medium') {
    score += 0.25;
    reasons.push(`structural analysis matched a ${analysis.patternType} pattern`);
  }

  const clamped = Math.min(1, Math.max(0, score));
  let verdict =
    clamped >= thresholds.confirmed
      ? InvestigationVerdict.CONFIRMED_LEAK
      : clamped >= thresholds.likely
        ? InvestigationVerdict.LIKELY_LEAK
        : InvestigationVerdict.UNCERTAIN;

  const structuralHigh = analysis.structuralLikelihood === 'high';

  // ── Precision gate 1 — clean dynamic run is exculpatory. A sanitizer exercised
  // this site and reported no leak, and no decisive static evidence says otherwise
  // → answer likely_false_positive (non-borderline, so it neither flags NOR escalates
  // to the LLM, which can't see the whole program). Every Juliet `*_bad` either leaks
  // at runtime (correlated leak) or frees nowhere (structural 'high'), so this never
  // fires for a real flaw → recall preserved. ──
  if (dynamicallyCleared && !correlatedRuntimeLeak && !structuralHigh) {
    return {
      verdict: InvestigationVerdict.LIKELY_FALSE_POSITIVE,
      confidence: 0.8,
      explanation: `A dynamic run exercised this allocation and reported no leak; the remaining static signals are weak.${reasons.length ? ` (${reasons.join('; ')})` : ''}`,
      evidence: bundle.evidence.map((e) => `${e.tool}: ${e.function_name}`),
      tool: ToolKind.HEURISTIC,
    };
  }

  // ── Precision gate 2 — require a decisive signal to flag. A flagged verdict must
  // rest on at least ONE strong signal (correlated runtime leak, a structurally
  // located missing-free, an unpaired alloc→free, or malloc_without_free ownership);
  // a pile of weak lexical heuristics alone is downgraded to `uncertain` rather than
  // asserted as a leak. Bad variants always carry a strong signal → recall preserved. ──
  const hasStrongSignal =
    correlatedRuntimeLeak ||
    structuralHigh ||
    candidatePair?.status === 'unpaired' ||
    pathSensitiveLeak ||
    hasOwnershipIssue;
  const flagged =
    verdict === InvestigationVerdict.CONFIRMED_LEAK || verdict === InvestigationVerdict.LIKELY_LEAK;
  if (flagged && !hasStrongSignal) {
    verdict = InvestigationVerdict.UNCERTAIN;
    reasons.push('no decisive leak signal (weak static heuristics only) — not flagged');
  }

  return {
    verdict,
    confidence: verdict === InvestigationVerdict.UNCERTAIN ? Math.max(clamped, 0.3) : clamped,
    explanation: analysis.explanation || `${verdict} at ${location}: ${reasons.join('; ')}`,
    evidence: bundle.evidence.map((e) => `${e.tool}: ${e.function_name}`),
    tool: ToolKind.HEURISTIC,
    repair_suggestion: buildRepairSuggestion(bundle, staticContext),
    rootCause: analysis.rootCause,
    repairDiff: analysis.repairDiff,
  };
}

/**
 * Ensure a leak verdict ships a structured root cause + an applicable repair
 * diff. Validates any LLM-provided diff against the real file and replaces it
 * with a deterministic, source-anchored diff when it does not match.
 */
export function enrichLeakVerdict(
  bundle: LeakBundle,
  staticContext: Record<string, any> | undefined,
  verdict: VerdictResult,
): VerdictResult {
  const isLeak =
    verdict.verdict === InvestigationVerdict.CONFIRMED_LEAK ||
    verdict.verdict === InvestigationVerdict.LIKELY_LEAK ||
    verdict.verdict === InvestigationVerdict.UNCERTAIN;
  if (!isLeak) return verdict;

  const fileContent = readFullFile(bundle.candidate.file_path);
  const analysis = analyzeLeakHeuristically(bundle, staticContext, fileContent);
  // Consensus verdicts are LLM-derived too — keep their (combined) explanation.
  const fromLlm = verdict.tool === ToolKind.LLM || verdict.tool === ToolKind.CONSENSUS;

  const llmDiffUsable =
    !!verdict.repairDiff &&
    isDiffApplicable(verdict.repairDiff, fileContent) &&
    diffAddsCleanup(verdict.repairDiff) &&
    diffIsMinimal(verdict.repairDiff);
  const repairDiff = analysis.repairDiff || (llmDiffUsable ? verdict.repairDiff : undefined);

  return {
    ...verdict,
    rootCause: verdict.rootCause || analysis.rootCause,
    repairDiff,
    explanation: fromLlm && verdict.explanation ? verdict.explanation : analysis.explanation,
    repair_suggestion: verdict.repair_suggestion || analysis.rootCause.rootCauseDescription,
  };
}

/** True when the diff's originalLines match the file verbatim at startLine. */
export function isDiffApplicable(diff: RepairDiff, fileContent: string | null): boolean {
  if (!fileContent || !diff || !Array.isArray(diff.originalLines) || diff.originalLines.length === 0) return false;
  const lines = fileContent.split('\n');
  const start = (diff.startLine || 0) - 1;
  if (start < 0 || start >= lines.length) return false;
  for (let k = 0; k < diff.originalLines.length; k++) {
    if ((lines[start + k] ?? '').trim() !== String(diff.originalLines[k]).trim()) return false;
  }
  return true;
}

/** True when the diff actually adds a deallocation the original lines lacked. Matches the
 * whole dealloc FAMILY (prefixed, any case) so PROJECT deallocators count too — cJSON's
 * `cJSON_Delete` (capital D) / `cJSON_free`, GLib `g_object_unref`, apr `apr_pool_destroy`
 * — not just libc `free`. `extraDeallocators` (LLM-discovered) pins exact names when given. */
export function diffAddsCleanup(diff: RepairDiff, extraDeallocators?: string[]): boolean {
  const exact = (extraDeallocators || []).filter((s) => /^[A-Za-z_]\w*$/.test(s));
  const family = `\\b\\w*(?:free|delete|destroy|release|cleanup|dealloc|unref|dispose|fclose)\\w*\\s*\\(`;
  const pinned = exact.length ? `|\\b(?:${exact.join('|')})\\s*\\(` : '';
  const dealloc = new RegExp(`${family}${pinned}`, 'i');
  const added = (diff.suggestedLines || []).join('\n');
  const original = (diff.originalLines || []).join('\n');
  return dealloc.test(added) && !dealloc.test(original);
}

/** True when the diff is a small targeted edit, not a whole-file rewrite. */
export function diffIsMinimal(diff: RepairDiff): boolean {
  const added = (diff.suggestedLines || []).length;
  const orig = (diff.originalLines || []).length;
  return added > 0 && added - orig <= 4;
}

export function buildRepairSuggestion(bundle: LeakBundle, staticContext?: Record<string, any>): string {
  const alloc = bundle.candidate.allocation_type || 'allocation';
  const frees = staticContext?.frees || [];

  if (frees.length === 0) {
    return `Ensure the object allocated via ${alloc} in ${bundle.candidate.function_name || 'this function'} is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.`;
  }

  if ((staticContext?.feasiblePaths || []).length > 0) {
    return `Review conditional branches around ${bundle.candidate.file_path}:${bundle.candidate.line_number}. At least one feasible path reaches function exit without hitting the observed free sites (${frees.join(', ')}). Move cleanup into a shared epilogue or use a single-exit cleanup label.`;
  }

  return `Document ownership for the value allocated at ${bundle.candidate.file_path}:${bundle.candidate.line_number} and ensure one matching free/delete occurs after the last use.`;
}
