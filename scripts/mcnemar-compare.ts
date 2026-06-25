#!/usr/bin/env bun
/**
 * McNemar paired-significance comparison of two eval runs (Tier-2). This is the
 * defensible test behind a claim like "consensus beats single-LLM": both arms are
 * scored over the SAME ground-truth sites, so we compare them site-by-site rather
 * than comparing two independent aggregate numbers.
 *
 *   bun scripts/mcnemar-compare.ts <runA>[/metrics.json] <runB>[/metrics.json]
 *   bun scripts/mcnemar-compare.ts single=/tmp/s1/metrics.json consensus=/tmp/c3/metrics.json
 *
 * Each run's `metrics.json` must carry the per-site `samples` array (with `siteId`)
 * that the eval harness now persists — older runs predate it and must be re-run.
 * Samples are aligned by `siteId`; `mcnemar` (in @cleak/common) returns the
 * discordant counts b01/b10, the continuity-corrected χ², and a two-sided p-value.
 *
 * Exit 0 (it is a report). Exits 2 on a degenerate/missing-samples run.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mcnemar, accumulate, computeMetrics, type Sample } from '@cleak/common/analysis/metrics';

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('usage: bun scripts/mcnemar-compare.ts <runA> <runB>   (dir or metrics.json; optional label=path)');
  process.exit(2);
}

/** Accept `label=path` or a bare path (label derived from the path). */
function parseArg(a: string): { label: string; path: string } {
  const eq = a.indexOf('=');
  // Only treat as label=path when the bit before '=' has no path separator.
  if (eq > 0 && !a.slice(0, eq).includes('/')) return { label: a.slice(0, eq), path: a.slice(eq + 1) };
  return { label: a.replace(/\/metrics\.json$/, '').split('/').filter(Boolean).pop() ?? a, path: a };
}

function metricsPath(p: string): string {
  try {
    return statSync(p).isDirectory() ? join(p, 'metrics.json') : p;
  } catch {
    return p;
  }
}

const inputs = args.map(parseArg);
const runs = inputs.map((it) => {
  const r = JSON.parse(readFileSync(metricsPath(it.path), 'utf-8'));
  const samples: Sample[] = Array.isArray(r.samples) ? r.samples : [];
  if (samples.length === 0) {
    console.error(`✗ ${it.label} (${it.path}) has no \`samples\` — re-run the eval with the current harness (EvalResult now persists per-site samples).`);
    process.exit(2);
  }
  const withIds = samples.filter((s) => s.siteId != null).length;
  return { ...it, r, samples, withIds };
});

const [A, B] = runs;
const idCoverage = Math.min(A.withIds / A.samples.length, B.withIds / B.samples.length);
if (idCoverage < 1) {
  console.error(
    `⚠ only ${(idCoverage * 100).toFixed(0)}% of samples carry a siteId; pairing falls back to positional order for the rest.`,
  );
}

const res = mcnemar(A.samples, B.samples);

// Per-arm accuracy on the full sample set (context for the paired test).
const acc = (s: Sample[]) => s.filter((x) => x.predicted === x.actual).length / s.length;
const f1 = (s: Sample[]) => computeMetrics(accumulate(s)).f1;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`McNemar paired test · ${A.label} vs ${B.label}\n`);
console.log(`  paired sites (n)     : ${res.n}`);
console.log(`  ${A.label.padEnd(18)} : acc ${pct(acc(A.samples))}  F1 ${f1(A.samples).toFixed(3)}  (${A.samples.length} samples)`);
console.log(`  ${B.label.padEnd(18)} : acc ${pct(acc(B.samples))}  F1 ${f1(B.samples).toFixed(3)}  (${B.samples.length} samples)`);
console.log('');
console.log(`  discordant b01       : ${res.b01}  (${A.label} wrong, ${B.label} right)`);
console.log(`  discordant b10       : ${res.b10}  (${A.label} right, ${B.label} wrong)`);
console.log(`  χ² (continuity-corr) : ${res.chi2.toFixed(4)}   (1 d.f.)`);
console.log(`  two-sided p-value    : ${res.pValue.toExponential(3)}`);

const better = res.b01 === res.b10 ? null : res.b01 > res.b10 ? B.label : A.label;
const sig = res.pValue < 0.05;
console.log('');
if (res.b01 + res.b10 === 0) {
  console.log('  → no discordant pairs: the two arms classify every paired site identically.');
} else if (sig && better) {
  console.log(`  → SIGNIFICANT at α=0.05: ${better} is better on the discordant sites (p=${res.pValue.toExponential(2)}).`);
} else {
  console.log(
    `  → NOT significant at α=0.05${better ? ` (lean: ${better})` : ''}. ` +
      `Discordant pairs are too few/balanced to reject "no difference" — report the trend with its CI, not as a win.`,
  );
}
