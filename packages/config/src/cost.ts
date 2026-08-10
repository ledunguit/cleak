import type { RunConfig } from './types.js';

export interface CostComputation {
  costUsd: number | undefined;
  /** false ⇒ `costUsd` is undefined because no price is configured for this
   * model, NOT because the cost is actually $0 — callers must not conflate
   * the two when rendering a report. */
  priced: boolean;
}

export function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  modelId: string | undefined,
  pricing: RunConfig['pricing'] | undefined,
): CostComputation {
  const price = modelId ? pricing?.[modelId] : undefined;
  if (!price || price.inputPerMillion == null || price.outputPerMillion == null) {
    return { costUsd: undefined, priced: false };
  }
  const costUsd = (inputTokens / 1_000_000) * price.inputPerMillion + (outputTokens / 1_000_000) * price.outputPerMillion;
  return { costUsd, priced: true };
}
