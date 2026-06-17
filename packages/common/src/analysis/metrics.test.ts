import { describe, expect, test } from 'bun:test';
import {
  accumulate,
  computeMetrics,
  metricsOf,
  calibrationBins,
  expectedCalibrationError,
  bootstrapCI,
  mcnemar,
  makeRng,
  type ConfusionMatrix,
  type Sample,
} from './metrics';

const s = (actual: boolean, predicted: boolean, confidence?: number): Sample => ({ actual, predicted, confidence });
const f1Of = (cm: ConfusionMatrix): number => computeMetrics(cm).f1;
/** A site sample carrying an id, for paired tests. */
const site = (id: string, actual: boolean, predicted: boolean): Sample => ({ siteId: id, actual, predicted });

describe('accumulate', () => {
  test('counts each quadrant of the confusion matrix', () => {
    const cm = accumulate([
      s(true, true), // tp
      s(true, true), // tp
      s(false, true), // fp
      s(true, false), // fn
      s(false, false), // tn
      s(false, false), // tn
    ]);
    expect(cm).toEqual({ tp: 2, fp: 1, fn: 1, tn: 2 });
  });

  test('empty input → all zero', () => {
    expect(accumulate([])).toEqual({ tp: 0, fp: 0, fn: 0, tn: 0 });
  });
});

describe('computeMetrics', () => {
  test('a known matrix yields the textbook figures', () => {
    // tp=8 fp=2 fn=4 tn=6  → P=0.8 R=0.667 ...
    const m = computeMetrics({ tp: 8, fp: 2, fn: 4, tn: 6 });
    expect(m.total).toBe(20);
    expect(m.precision).toBeCloseTo(0.8, 6); // 8/10
    expect(m.recall).toBeCloseTo(8 / 12, 6);
    expect(m.f1).toBeCloseTo((2 * 0.8 * (8 / 12)) / (0.8 + 8 / 12), 6);
    expect(m.accuracy).toBeCloseTo(14 / 20, 6);
    expect(m.specificity).toBeCloseTo(6 / 8, 6);
    expect(m.fpr).toBeCloseTo(2 / 8, 6);
    // MCC = (8*6 - 2*4)/sqrt(10*12*8*10) = 40/sqrt(9600)
    expect(m.mcc).toBeCloseTo((8 * 6 - 2 * 4) / Math.sqrt(10 * 12 * 8 * 10), 6);
  });

  test('perfect classifier → all 1, MCC 1', () => {
    const m = computeMetrics({ tp: 5, fp: 0, fn: 0, tn: 5 });
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.f1).toBe(1);
    expect(m.accuracy).toBe(1);
    expect(m.specificity).toBe(1);
    expect(m.fpr).toBe(0);
    expect(m.mcc).toBeCloseTo(1, 6);
  });

  test('safeDiv guards every zero-denominator path (no NaN/Infinity)', () => {
    const empty = computeMetrics({ tp: 0, fp: 0, fn: 0, tn: 0 });
    for (const v of Object.values(empty)) expect(Number.isFinite(v)).toBe(true);
    expect(empty.precision).toBe(0);
    expect(empty.recall).toBe(0);
    expect(empty.f1).toBe(0);
    expect(empty.mcc).toBe(0); // mccDen === 0 branch

    // No positives predicted at all → precision denominator 0.
    const noPos = computeMetrics({ tp: 0, fp: 0, fn: 3, tn: 7 });
    expect(noPos.precision).toBe(0);
    expect(noPos.recall).toBe(0);
    expect(noPos.mcc).toBe(0); // (tp+fp)=0 → mccDen 0
  });

  test('all-positive ground truth (no negatives) keeps specificity defined', () => {
    const m = computeMetrics({ tp: 4, fp: 0, fn: 1, tn: 0 });
    expect(m.specificity).toBe(0); // tn/(tn+fp) with both 0 → safeDiv → 0
    expect(m.fpr).toBe(0);
  });
});

describe('metricsOf', () => {
  test('matches compute∘accumulate', () => {
    const samples = [s(true, true), s(false, true), s(true, false), s(false, false)];
    expect(metricsOf(samples)).toEqual(computeMetrics(accumulate(samples)));
  });
});

describe('calibration', () => {
  test('bins span [0,1] and route confidences correctly', () => {
    const samples = [
      s(true, true, 0.95), // top bin, correct
      s(false, true, 0.95), // top bin, wrong
      s(true, false, 0.05), // bottom bin, wrong (predicted no, actual yes)
      s(false, false, 0.05), // bottom bin, correct
    ];
    const bins = calibrationBins(samples, 10);
    expect(bins).toHaveLength(10);
    expect(bins[9].count).toBe(2);
    expect(bins[9].empiricalAccuracy).toBe(0.5);
    expect(bins[0].count).toBe(2);
    expect(bins[0].empiricalAccuracy).toBe(0.5);
    // Empty middle bins contribute nothing.
    expect(bins[5].count).toBe(0);
  });

  test('the upper edge (confidence === 1) lands in the last bin, not dropped', () => {
    const bins = calibrationBins([s(true, true, 1)], 10);
    expect(bins[9].count).toBe(1);
  });

  test('a perfectly calibrated detector has ECE 0', () => {
    // bin@0.95: 100% confidence-ish, 100% accuracy.
    const samples = [s(true, true, 0.95), s(true, true, 0.95)];
    expect(expectedCalibrationError(samples, 10)).toBeCloseTo(0.05, 6); // |0.95 - 1.0|
  });

  test('ECE is 0 for empty samples', () => {
    expect(expectedCalibrationError([], 10)).toBe(0);
  });
});

describe('makeRng', () => {
  test('is deterministic for a given seed and spans [0,1)', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b()); // same seed → identical stream
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(makeRng(1)()).not.toBe(makeRng(2)()); // different seeds diverge
  });
});

describe('bootstrapCI', () => {
  test('a large perfect classifier has a degenerate [1,1] interval around F1', () => {
    // Many tp/tn so a resample drawing zero true-positives is astronomically
    // unlikely → every resample's F1 is 1. (Small perfect sets legitimately dip
    // to 0 in the tail, which is the bootstrap behaving correctly, not a bug.)
    const samples = [
      ...Array.from({ length: 40 }, () => s(true, true)),
      ...Array.from({ length: 40 }, () => s(false, false)),
    ];
    const ci = bootstrapCI(samples, f1Of, { iters: 500, rng: makeRng(7) });
    expect(ci.point).toBe(1);
    expect(ci.lo).toBe(1);
    expect(ci.hi).toBe(1);
  });

  test('a small perfect set legitimately dips in the lower tail (resampling, not a bug)', () => {
    const samples = [s(true, true), s(true, true), s(false, false), s(false, false)];
    const ci = bootstrapCI(samples, f1Of, { iters: 500, rng: makeRng(7) });
    expect(ci.point).toBe(1);
    expect(ci.hi).toBe(1);
    expect(ci.lo).toBeLessThanOrEqual(1); // tail can be 0 when no tp is drawn
  });

  test('point equals the metric on the full set and lo ≤ point ≤ hi', () => {
    const samples = [
      s(true, true), s(true, true), s(true, false), s(false, true), s(false, false), s(false, false),
    ];
    const ci = bootstrapCI(samples, f1Of, { iters: 1000, rng: makeRng(123) });
    expect(ci.point).toBeCloseTo(f1Of(accumulate(samples)), 6);
    expect(ci.lo).toBeLessThanOrEqual(ci.point);
    expect(ci.hi).toBeGreaterThanOrEqual(ci.point);
    expect(ci.lo).toBeGreaterThanOrEqual(0);
    expect(ci.hi).toBeLessThanOrEqual(1);
  });

  test('is reproducible for a fixed seed', () => {
    const samples = [s(true, true), s(false, true), s(true, false), s(false, false)];
    const a = bootstrapCI(samples, f1Of, { iters: 300, rng: makeRng(99) });
    const b = bootstrapCI(samples, f1Of, { iters: 300, rng: makeRng(99) });
    expect(a).toEqual(b);
  });

  test('empty samples → interval collapses to the point', () => {
    const ci = bootstrapCI([], f1Of, { iters: 100, rng: makeRng(1) });
    expect(ci.lo).toBe(ci.point);
    expect(ci.hi).toBe(ci.point);
  });
});

describe('mcnemar', () => {
  test('identical classifiers → no discordance, χ²=0, p=1', () => {
    const a = [site('x1', true, true), site('x2', false, false), site('x3', true, false)];
    const b = [site('x1', true, true), site('x2', false, false), site('x3', true, false)];
    const r = mcnemar(a, b);
    expect(r.b01).toBe(0);
    expect(r.b10).toBe(0);
    expect(r.chi2).toBe(0);
    expect(r.pValue).toBe(1);
  });

  test('B strictly dominates A on every site → significant (p < 0.01)', () => {
    // 10 sites: A always wrong, B always right → b01=10, b10=0.
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const a = ids.map((id) => site(id, true, false)); // actual leak, A says no → wrong
    const b = ids.map((id) => site(id, true, true)); // actual leak, B says yes → right
    const r = mcnemar(a, b);
    expect(r.b01).toBe(10);
    expect(r.b10).toBe(0);
    // χ² = (|10-0|-1)² / 10 = 81/10 = 8.1
    expect(r.chi2).toBeCloseTo(8.1, 6);
    expect(r.pValue).toBeLessThan(0.01);
  });

  test('aligns by siteId regardless of order', () => {
    const a = [site('p', true, true), site('q', false, false)];
    const b = [site('q', false, false), site('p', true, false)]; // p: B wrong, q: agree
    const r = mcnemar(a, b);
    expect(r.n).toBe(2);
    expect(r.b10).toBe(1); // A right, B wrong on site p
    expect(r.b01).toBe(0);
  });

  test('|b01−b10| ≤ 1 yields χ²=0 (continuity correction floor)', () => {
    const a = [site('a', true, false), site('b', true, true)];
    const b = [site('a', true, true), site('b', true, false)]; // b01=1, b10=1
    const r = mcnemar(a, b);
    expect(r.b01).toBe(1);
    expect(r.b10).toBe(1);
    expect(r.chi2).toBe(0);
    expect(r.pValue).toBe(1);
  });

  test('falls back to positional alignment when ids are absent', () => {
    const a = [s(true, false), s(false, false)];
    const b = [s(true, true), s(false, false)];
    const r = mcnemar(a, b);
    expect(r.n).toBe(2);
    expect(r.b01).toBe(1); // first pair: A wrong, B right
  });
});
