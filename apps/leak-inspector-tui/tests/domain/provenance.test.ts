import { describe, expect, test } from 'bun:test';
import { captureProvenance, summarizeStat } from '../../src/domain/provenance';

describe('captureProvenance', () => {
  test('returns correct shape with all fields', () => {
    const result = captureProvenance({
      provider: 'anthropic',
      model: 'claude-3-opus',
      temperature: 0,
      dynamicEnabled: true,
      corpusHash: 'abc123def456',
      corpusValidated: true,
      runs: 3,
      consensus: { n: 3, rule: 'weighted' },
    });
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-3-opus');
    expect(result.temperature).toBe(0);
    expect(result.runs).toBe(3);
    expect(result.corpusHash).toBe('abc123def456');
    expect(result.corpusValidated).toBe(true);
    expect(result.consensus).toEqual({ n: 3, rule: 'weighted' });
    expect(result.toolVersions).toBeDefined();
    expect(typeof result.toolVersions).toBe('object');
    // gitCommit depends on whether git rev-parse HEAD succeeds in the test env
    // If git is available, it's a string; if not, it's undefined — both are acceptable
    if (result.gitCommit !== undefined) {
      expect(typeof result.gitCommit).toBe('string');
    }
  });

  test('works with minimal opts (dynamicEnabled only)', () => {
    const result = captureProvenance({ dynamicEnabled: false });
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.temperature).toBeUndefined();
    expect(result.runs).toBeUndefined();
    expect(result.corpusHash).toBeUndefined();
    expect(result.corpusValidated).toBeUndefined();
    expect(result.consensus).toBeUndefined();
    expect(result.toolVersions).toBeDefined();
  });

  test('omits consensus when not provided', () => {
    const result = captureProvenance({ dynamicEnabled: true });
    expect(result.consensus).toBeUndefined();
  });
});

describe('summarizeStat', () => {
  test('computes mean, std, min, max for known values', () => {
    const s = summarizeStat([1, 2, 3, 4, 5]);
    expect(s.mean).toBe(3);
    expect(s.std).toBeCloseTo(1.581, 2); // sqrt(2.5) ≈ 1.581
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.n).toBe(5);
  });

  test('single value has std 0', () => {
    const s = summarizeStat([42]);
    expect(s.mean).toBe(42);
    expect(s.std).toBe(0);
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.n).toBe(1);
  });

  test('empty array returns zeros', () => {
    const s = summarizeStat([]);
    expect(s.mean).toBe(0);
    expect(s.std).toBe(0);
    expect(s.min).toBe(0);
    expect(s.max).toBe(0);
    expect(s.n).toBe(0);
  });

  test('variance with two values', () => {
    const s = summarizeStat([10, 20]);
    expect(s.mean).toBe(15);
    expect(s.std).toBeCloseTo(7.071, 2); // sqrt(50) ≈ 7.071
    expect(s.min).toBe(10);
    expect(s.max).toBe(20);
  });
});
