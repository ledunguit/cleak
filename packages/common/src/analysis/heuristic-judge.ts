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
  let dynamicallyObserved = false;
  let dynamicLeakObserved = false;
  if (bundle.evidence.length > 0) {
    let dyn = 0;
    let dynReason = '';
    for (const e of bundle.evidence) {
      dynamicallyObserved = true;
      if (!evidenceIndicatesLeak(e)) continue; // clean run / still_reachable — not a leak
      dynamicLeakObserved = true;
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
        c = 0.15; // same-file / uncorrelated leak finding — weak
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
  // A completed dynamic run that exercised this candidate but found NO leak at this
  // site is exculpatory — the strongest precision signal for Juliet good* variants.
  const dynamicallyCleared = dynamicallyObserved && !dynamicLeakObserved;

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
    score -= correlatedLeak ? 0.1 : 0.25;
    reasons.push(`ownership transferred (${se.ownership.ownershipCarrier?.kind}) — likely the caller's to free`);
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
    clamped >= 0.7
      ? InvestigationVerdict.CONFIRMED_LEAK
      : clamped >= 0.4
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
  const fromLlm = verdict.tool === ToolKind.LLM;

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

/** True when the diff actually adds a deallocation the original lines lacked. */
export function diffAddsCleanup(diff: RepairDiff): boolean {
  const dealloc = /\b(free|delete|g_free|kfree|fclose|release|destroy|cleanup|realloc)\s*\(/;
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
