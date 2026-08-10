/**
 * Centralized investigation/judge tunables. These were magic numbers scattered
 * across llmJudge / scanController; collecting them here documents the decision
 * boundaries (which the thesis ablates) and gives one place to change them.
 *
 * Defaults are unchanged from the previous inline values, so behaviour (and the
 * Tier-1 determinism baseline) is identical unless an override is set.
 *
 * Values are sourced from the config file via RunConfig.thresholds / RunConfig.workflow.
 */

export interface ThresholdsInput {
  borderlineLow?: number;
  borderlineHigh?: number;
  discoveryConcurrency?: number;
}

export function makeThresholds(cfg?: ThresholdsInput) {
  return {
    /**
     * Heuristic-confidence band in which a non-leak/non-uncertain verdict is still
     * "borderline" → worth an LLM (consensus) second opinion. The band edges are a
     * primary ablation lever (config: thresholds.borderlineLow / borderlineHigh).
     */
    borderlineLow: cfg?.borderlineLow ?? 0.35,
    borderlineHigh: cfg?.borderlineHigh ?? 0.7,

    /** Source window the judge sees when the enclosing function can't be bounded. */
    snippetFallbackBefore: 6,
    snippetFallbackAfter: 5,

    /** Caps on how much static context is rendered into the judge prompt. */
    maxAllocFreePairsShown: 12,
    maxFeasibleLeakPathsShown: 5,

    /**
     * Discovery file-scan concurrency (MCP workers per case hitting static-analyzer).
     * Lowered 8→4: at the old default, a corpus eval's case-level concurrency (up to
     * 6 in `no_llm` mode) stacked with this to put up to 48 concurrent MCP calls on
     * static-analyzer, timing out on the largest repos (reproduced directly: 9/19
     * MemHint cases timed out at defaults). This is a stopgap independent of the
     * static-analyzer worker-thread pool fix — it caps load from the CALLER side;
     * the pool fixes the SERVER side (parsing no longer serializes on one thread).
     */
    discoveryConcurrency: Math.max(1, cfg?.discoveryConcurrency ?? 4),
  };
}

/** Default thresholds (used when no config is available). */
export const THRESHOLDS = makeThresholds();
