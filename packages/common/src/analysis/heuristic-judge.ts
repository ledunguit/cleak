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
  const hasDynamicEvidence = bundle.evidence.length > 0;
  const hasStaticFree = staticContext?.hasExplicitFree === true;
  const hasStaticAllocation = (staticContext?.allocations || []).length > 0;
  const hasFeasiblePaths = (staticContext?.feasiblePaths || []).length > 0;
  const hasOwnershipIssue = staticContext?.ownership?.ownershipType === 'malloc_without_free';
  const earlyReturnCount: number = staticContext?.earlyReturnCount || 0;
  const location = `${bundle.candidate.file_path}:${bundle.candidate.line_number}`;

  let score = 0;
  const reasons: string[] = [];

  if (hasDynamicEvidence) {
    score += 0.4;
    reasons.push(`${bundle.evidence.length} tool(s) found runtime evidence`);
  }

  if (hasFeasiblePaths) {
    score += 0.2;
    reasons.push('allocation reachable through feasible execution path(s)');
  }

  if (!hasStaticFree && hasStaticAllocation) {
    score += 0.25;
    reasons.push('no free() found in function for this allocation');
  }

  if (hasOwnershipIssue) {
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

  // Source-level structural analysis is the primary evidence in no_llm mode,
  // where the lexical static context above is frequently sparse.
  const analysis = analyzeLeakHeuristically(bundle, staticContext, readFullFile(bundle.candidate.file_path));
  if (analysis.structuralLikelihood === 'high') {
    score += 0.5;
    reasons.push(`structural analysis located a missing free (${analysis.patternType})`);
  } else if (analysis.structuralLikelihood === 'medium') {
    score += 0.25;
    reasons.push(`structural analysis matched a ${analysis.patternType} pattern`);
  }

  const clamped = Math.min(1, Math.max(0, score));
  const verdict =
    clamped >= 0.7
      ? InvestigationVerdict.CONFIRMED_LEAK
      : clamped >= 0.4
        ? InvestigationVerdict.LIKELY_LEAK
        : InvestigationVerdict.UNCERTAIN;

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
