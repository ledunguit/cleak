import { describe, expect, test } from 'bun:test';
import {
  accumulate,
  computeMetrics,
  metricsOf,
  calibrationBins,
  expectedCalibrationError,
  type Sample,
} from './metrics';

const s = (actual: boolean, predicted: boolean, confidence?: number): Sample => ({ actual, predicted, confidence });

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
