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
