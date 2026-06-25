/**
 * Centralized investigation/judge tunables. These were magic numbers scattered
 * across llmJudge / scanController; collecting them here documents the decision
 * boundaries (which the thesis ablates) and gives one place to change them. Knobs
 * worth tuning at run time read an env override; the rest are fixed constants.
 *
 * Defaults are unchanged from the previous inline values, so behaviour (and the
 * Tier-1 determinism baseline) is identical unless an override is set.
 */
function num(envValue: string | undefined, fallback: number): number {
  const n = Number(envValue);
  return Number.isFinite(n) ? n : fallback;
}

export const THRESHOLDS = {
  /**
   * Heuristic-confidence band in which a non-leak/non-uncertain verdict is still
   * "borderline" → worth an LLM (consensus) second opinion. The band edges are a
   * primary ablation lever (env `JUDGE_BORDERLINE_LOW` / `JUDGE_BORDERLINE_HIGH`).
   */
  borderlineLow: num(process.env.JUDGE_BORDERLINE_LOW, 0.35),
  borderlineHigh: num(process.env.JUDGE_BORDERLINE_HIGH, 0.7),

  /** Source window the judge sees when the enclosing function can't be bounded. */
  snippetFallbackBefore: 6,
  snippetFallbackAfter: 5,

  /** Caps on how much static context is rendered into the judge prompt. */
  maxAllocFreePairsShown: 12,
  maxFeasibleLeakPathsShown: 5,

  /** Discovery file-scan concurrency (env-driven for the single local gateway). */
  discoveryConcurrency: Math.max(1, num(process.env.DISCOVERY_CONCURRENCY, 8)),
} as const;
