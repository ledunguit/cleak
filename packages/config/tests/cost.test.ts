import { describe, expect, test } from 'vitest';
import { computeCostUsd } from '../src/cost';

describe('computeCostUsd', () => {
  test('no pricing table → unpriced, not $0', () => {
    expect(computeCostUsd(1000, 500, 'claude-sonnet-5', undefined)).toEqual({ costUsd: undefined, priced: false });
  });

  test('no entry for this model ID → unpriced', () => {
    const pricing = { 'other-model': { inputPerMillion: 3, outputPerMillion: 15 } };
    expect(computeCostUsd(1000, 500, 'claude-sonnet-5', pricing)).toEqual({ costUsd: undefined, priced: false });
  });

  test('undefined model ID → unpriced', () => {
    const pricing = { 'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 } };
    expect(computeCostUsd(1000, 500, undefined, pricing)).toEqual({ costUsd: undefined, priced: false });
  });

  test('missing outputPerMillion → still unpriced, not a partial number', () => {
    const pricing = { 'claude-sonnet-5': { inputPerMillion: 3 } };
    expect(computeCostUsd(1000, 500, 'claude-sonnet-5', pricing)).toEqual({ costUsd: undefined, priced: false });
  });

  test('missing inputPerMillion → still unpriced', () => {
    const pricing = { 'claude-sonnet-5': { outputPerMillion: 15 } };
    expect(computeCostUsd(1000, 500, 'claude-sonnet-5', pricing)).toEqual({ costUsd: undefined, priced: false });
  });

  test('both prices configured → correct arithmetic', () => {
    const pricing = { 'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 } };
    const { costUsd, priced } = computeCostUsd(1_000_000, 1_000_000, 'claude-sonnet-5', pricing);
    expect(priced).toBe(true);
    expect(costUsd).toBeCloseTo(3 + 15, 10);
  });

  test('zero tokens with a valid price → $0, genuinely priced (not the unpriced case)', () => {
    const pricing = { 'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 } };
    expect(computeCostUsd(0, 0, 'claude-sonnet-5', pricing)).toEqual({ costUsd: 0, priced: true });
  });
});
