#!/usr/bin/env bun
/** Verifies the classification-metrics math against a hand-computed matrix. */

import { computeMetrics, metricsOf, calibrationBins, type Sample } from '@cleak/common/analysis/metrics';

const approx = (a: number, b: number, eps = 0.001) => Math.abs(a - b) < eps;
const fail = (m: string) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

// tp=8, fp=2, fn=3, tn=87
const m = computeMetrics({ tp: 8, fp: 2, fn: 3, tn: 87 });
if (!approx(m.precision, 0.8)) fail(`precision ${m.precision} != 0.80`);
if (!approx(m.recall, 0.7273)) fail(`recall ${m.recall} != 0.727`);
if (!approx(m.f1, 0.7619)) fail(`f1 ${m.f1} != 0.762`);
if (!approx(m.accuracy, 0.95)) fail(`accuracy ${m.accuracy} != 0.95`);
if (!approx(m.specificity, 0.9775)) fail(`specificity ${m.specificity} != 0.978`);
if (!approx(m.fpr, 0.0225)) fail(`fpr ${m.fpr} != 0.022`);
if (!approx(m.mcc, 0.735, 0.01)) fail(`mcc ${m.mcc} != ~0.735`);
console.log(`✓ metrics: P=${m.precision.toFixed(3)} R=${m.recall.toFixed(3)} F1=${m.f1.toFixed(3)} Acc=${m.accuracy} Spec=${m.specificity.toFixed(3)} MCC=${m.mcc.toFixed(3)}`);

// accumulate from samples
const samples: Sample[] = [
  { actual: true, predicted: true, confidence: 0.95 },
  { actual: true, predicted: false, confidence: 0.3 },
  { actual: false, predicted: true, confidence: 0.6 },
  { actual: false, predicted: false, confidence: 0.1 },
];
const ms = metricsOf(samples);
if (ms.tp !== 1 || ms.fn !== 1 || ms.fp !== 1 || ms.tn !== 1) fail(`sample confusion wrong: ${JSON.stringify(ms)}`);
console.log(`✓ accumulate: tp=${ms.tp} fp=${ms.fp} fn=${ms.fn} tn=${ms.tn}`);

const bins = calibrationBins(samples, 5);
if (bins.length !== 5) fail(`expected 5 calibration bins, got ${bins.length}`);
console.log(`✓ calibration: ${bins.filter((b) => b.count > 0).length} non-empty bins`);

console.log('✓ metrics core verified');
