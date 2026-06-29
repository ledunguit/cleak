import { describe, expect, test } from 'bun:test';
import { selectCases } from './evalHarness';

// Mimic Juliet's skew: cases grouped by family in manifest order.
const corpus = [
  ...Array.from({ length: 8 }, (_, i) => ({ id: `char-${i}`, functionalVariant: 'char' })),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `int-${i}`, functionalVariant: 'int' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `new-${i}`, functionalVariant: 'new' })),
  { id: 'dtor-0', functionalVariant: 'destructor' },
];

describe('selectCases', () => {
  test('no limit → all cases, order unchanged', () => {
    expect(selectCases(corpus)).toEqual(corpus);
  });

  test('top-N (no stratify) reproduces the skew', () => {
    const sel = selectCases(corpus, 6);
    expect(sel.map((c) => c.functionalVariant)).toEqual(['char', 'char', 'char', 'char', 'char', 'char']);
  });

  test('stratified sample covers every family evenly (round-robin)', () => {
    const sel = selectCases(corpus, 8, 'functionalVariant');
    const fams = sel.map((c) => c.functionalVariant);
    // Round 0: one of each (4 families, sorted: char,destructor,int,new), round 1: families with ≥2.
    expect(sel).toHaveLength(8);
    expect(new Set(fams).size).toBe(4); // all 4 families represented
    expect(fams.slice(0, 4).sort()).toEqual(['char', 'destructor', 'int', 'new']);
  });

  test('stratified is deterministic (same input → same output)', () => {
    expect(selectCases(corpus, 7, 'functionalVariant')).toEqual(selectCases(corpus, 7, 'functionalVariant'));
  });

  test('stratified exhausts small groups then keeps filling from larger ones', () => {
    const sel = selectCases(corpus, 12, 'functionalVariant');
    const counts = sel.reduce<Record<string, number>>((a, c) => ((a[c.functionalVariant] = (a[c.functionalVariant] ?? 0) + 1), a), {});
    // destructor has only 1; char/int/new keep getting picked.
    expect(counts.destructor).toBe(1);
    expect(counts.char).toBeGreaterThanOrEqual(3);
    expect(sel).toHaveLength(12);
  });

  test('limit ≥ corpus size → all cases', () => {
    expect(selectCases(corpus, 999, 'functionalVariant')).toEqual(corpus);
  });
});
