/**
 * Classification metrics for benchmark evaluation — the scientific figures the
 * thesis reports. Pure, dependency-free. A `Sample` is one prediction compared
 * to ground truth: `actual` (is this really a leak?) vs `predicted` (did the
 * tool flag it?), plus the tool's `confidence` for calibration. From a set of
 * samples we build a confusion matrix and derive Precision, Recall, F1, etc.
 */

export interface Sample {
  /** Ground truth: the site is a real leak (a `bad`/flaw location). */
  actual: boolean;
  /** Prediction: the tool flagged it as a leak (verdict ∈ {confirmed, likely}). */
  predicted: boolean;
  /** Predicted confidence in [0,1], for calibration. */
  confidence?: number;
  /**
   * Globally-unique site identifier (`<caseId>::<siteKey>`). Lets two runs (e.g.
   * single-LLM vs consensus) be aligned site-by-site for a PAIRED significance
   * test (`mcnemar`). Optional: older callers and synthetic samples may omit it.
   */
  siteId?: string;
}

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface Metrics extends ConfusionMatrix {
  total: number;
  /** tp / (tp + fp) — of the sites we flagged, how many were real leaks. */
  precision: number;
  /** tp / (tp + fn) — of the real leaks, how many we caught. */
  recall: number;
  /** Harmonic mean of precision and recall. */
  f1: number;
  /** (tp + tn) / total. */
  accuracy: number;
  /** tn / (tn + fp) — true negative rate. */
  specificity: number;
  /** fp / (fp + tn) — false positive rate. */
  fpr: number;
  /** Matthews correlation coefficient — robust to class imbalance, in [-1, 1]. */
  mcc: number;
}

export function accumulate(samples: Sample[]): ConfusionMatrix {
  const cm: ConfusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const s of samples) {
    if (s.actual && s.predicted) cm.tp++;
    else if (!s.actual && s.predicted) cm.fp++;
    else if (s.actual && !s.predicted) cm.fn++;
    else cm.tn++;
  }
  return cm;
}

const safeDiv = (n: number, d: number): number => (d === 0 ? 0 : n / d);

export function computeMetrics(cm: ConfusionMatrix): Metrics {
  const { tp, fp, fn, tn } = cm;
  const total = tp + fp + fn + tn;
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const f1 = safeDiv(2 * precision * recall, precision + recall);
  const accuracy = safeDiv(tp + tn, total);
  const specificity = safeDiv(tn, tn + fp);
  const fpr = safeDiv(fp, fp + tn);
  const mccDen = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
  const mcc = mccDen === 0 ? 0 : (tp * tn - fp * fn) / mccDen;
  return { tp, fp, fn, tn, total, precision, recall, f1, accuracy, specificity, fpr, mcc };
}

export function metricsOf(samples: Sample[]): Metrics {
  return computeMetrics(accumulate(samples));
}

export interface CalibrationBin {
  /** Bin range [lo, hi). */
  lo: number;
  hi: number;
  count: number;
  /** Mean predicted confidence of samples in the bin. */
  meanConfidence: number;
  /** Empirical accuracy in the bin (fraction of predictions that were correct). */
  empiricalAccuracy: number;
}

/**
 * Reliability bins for confidence calibration: for predictions that the tool
 * flagged with confidence in each bin, how often were they actually leaks. A
 * well-calibrated detector has meanConfidence ≈ empiricalAccuracy per bin.
 */
export function calibrationBins(samples: Sample[], nBins = 10): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < nBins; i++) {
    const lo = i / nBins;
    const hi = (i + 1) / nBins;
    const inBin = samples.filter((s) => {
      const c = s.confidence ?? (s.predicted ? 1 : 0);
      return c >= lo && (i === nBins - 1 ? c <= hi : c < hi);
    });
    const count = inBin.length;
    const meanConfidence = count === 0 ? 0 : inBin.reduce((a, s) => a + (s.confidence ?? (s.predicted ? 1 : 0)), 0) / count;
    // "Correct" = prediction matched ground truth.
    const correct = inBin.filter((s) => s.predicted === s.actual).length;
    bins.push({ lo, hi, count, meanConfidence, empiricalAccuracy: count === 0 ? 0 : correct / count });
  }
  return bins;
}

/** Expected Calibration Error — weighted gap between confidence and accuracy. */
export function expectedCalibrationError(samples: Sample[], nBins = 10): number {
  const bins = calibrationBins(samples, nBins);
  const total = samples.length;
  if (total === 0) return 0;
  return bins.reduce((acc, b) => acc + (b.count / total) * Math.abs(b.meanConfidence - b.empiricalAccuracy), 0);
}

// ───────────────────────── Statistical significance ─────────────────────────
// The thesis reports a single number (e.g. F1) per configuration. To claim one
// configuration beats another we need (a) an interval around each number, and
// (b) a PAIRED test on the same sites. (a) is a percentile bootstrap; (b) is
// McNemar's test. Both are pure and dependency-free so they stay unit-testable.

/** Deterministic, seedable PRNG (mulberry32) — reproducible bootstrap intervals. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ConfidenceInterval {
  /** The metric on the full (un-resampled) sample set. */
  point: number;
  /** Lower / upper percentile bounds at the requested alpha. */
  lo: number;
  hi: number;
}

/**
 * Percentile bootstrap confidence interval for any confusion-matrix-derived
 * metric (precision, recall, F1, MCC, …). Resamples the per-site `samples` with
 * replacement `iters` times, recomputes the metric on each resample, and returns
 * the empirical [alpha/2, 1-alpha/2] quantiles. The RNG is injectable so a thesis
 * figure can be reproduced exactly (`makeRng(seed)`); defaults to `Math.random`.
 */
export function bootstrapCI(
  samples: Sample[],
  metric: (cm: ConfusionMatrix) => number,
  opts: { iters?: number; alpha?: number; rng?: () => number } = {},
): ConfidenceInterval {
  const iters = opts.iters ?? 1000;
  const alpha = opts.alpha ?? 0.05;
  const rng = opts.rng ?? Math.random;
  const n = samples.length;
  const point = metric(accumulate(samples));
  if (n === 0) return { point, lo: point, hi: point };
  const stats = new Array<number>(iters);
  for (let i = 0; i < iters; i++) {
    const cm: ConfusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
    for (let j = 0; j < n; j++) {
      const s = samples[Math.min(n - 1, (rng() * n) | 0)];
      if (s.actual && s.predicted) cm.tp++;
      else if (!s.actual && s.predicted) cm.fp++;
      else if (s.actual && !s.predicted) cm.fn++;
      else cm.tn++;
    }
    stats[i] = metric(cm);
  }
  stats.sort((x, y) => x - y);
  const q = (p: number): number => stats[Math.min(iters - 1, Math.max(0, Math.round(p * (iters - 1))))];
  return { point, lo: q(alpha / 2), hi: q(1 - alpha / 2) };
}

export interface McNemarResult {
  /** Discordant pairs: A wrong & B right (`b01`); A right & B wrong (`b10`). */
  b01: number;
  b10: number;
  /** Number of paired sites actually compared. */
  n: number;
  /** Continuity-corrected McNemar χ² statistic (1 d.f.). */
  chi2: number;
  /** Two-sided p-value (χ² survival, 1 d.f.). */
  pValue: number;
}

/** Align two sample sets by `siteId` (preferred) or positionally (fallback). */
function alignSamples(a: Sample[], b: Sample[]): Array<[Sample, Sample]> {
  const haveIds = a.length > 0 && b.length > 0 && a.every((s) => s.siteId != null) && b.every((s) => s.siteId != null);
  const out: Array<[Sample, Sample]> = [];
  if (haveIds) {
    const bById = new Map(b.map((s) => [s.siteId as string, s]));
    for (const sa of a) {
      const sb = bById.get(sa.siteId as string);
      if (sb) out.push([sa, sb]);
    }
    return out;
  }
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) out.push([a[i], b[i]]);
  return out;
}

/**
 * McNemar's paired test for two classifiers evaluated over the SAME sites — the
 * defensible way to claim "consensus beats single-LLM". Samples are aligned by
 * `siteId` (positional fallback). "Correct" = prediction matched ground truth.
 * Uses Edwards' continuity correction; the statistic is 0 (p=1) when there are no
 * discordant pairs or |b01−b10| ≤ 1.
 */
export function mcnemar(a: Sample[], b: Sample[]): McNemarResult {
  const pairs = alignSamples(a, b);
  let b01 = 0;
  let b10 = 0;
  for (const [sa, sb] of pairs) {
    const ca = sa.predicted === sa.actual;
    const cb = sb.predicted === sb.actual;
    if (!ca && cb) b01++;
    else if (ca && !cb) b10++;
  }
  const discordant = b01 + b10;
  const corrected = Math.max(0, Math.abs(b01 - b10) - 1);
  const chi2 = discordant === 0 ? 0 : (corrected * corrected) / discordant;
  return { b01, b10, n: pairs.length, chi2, pValue: chiSquareSurvival1df(chi2) };
}

/** Survival function P(X > x) for χ² with 1 d.f. = erfc(√(x/2)). */
function chiSquareSurvival1df(x: number): number {
  if (x <= 0) return 1;
  return erfc(Math.sqrt(x / 2));
}

/** Numerical erfc (max abs error ≈ 1.2e-7) — Numerical Recipes rational form. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  // Horner evaluation of the degree-9 polynomial in t.
  const poly =
    -1.26551223 +
    t * (1.00002368 +
    t * (0.37409196 +
    t * (0.09678418 +
    t * (-0.18628806 +
    t * (0.27886807 +
    t * (-1.13520398 +
    t * (1.48851587 +
    t * (-0.82215223 +
    t * 0.17087277)))))))); // 8 grouping parens closed here
  const ans = t * Math.exp(-z * z + poly);
  return x >= 0 ? ans : 2 - ans;
}
