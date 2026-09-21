#!/usr/bin/env -S tsx
/**
 * §4.2.2 table audit: reconcile the printed baseline-sweep table's arithmetic
 * semantics against the sweep artifacts (review Finding C.3 / S8 / I10).
 *
 * For each config, reads the pinned metrics.json (B1/B2/B3 top-level single-run;
 * B4/B5/B6/B6a/B6b/B7 run-1, the same convention as the printed CI column),
 * recomputes n_samples / positive-sample space / confusion cells / printed
 * precision, and writes a CSV so the table's mixed scoring semantics
 * (row-total drift 6037 vs 6042; all-positive spaces with TN = 0) are visible.
 *
 *   tsx scripts/table-audit.ts [sweepDir] [outCsv]
 *
 * Defaults: results/baseline-sweep-2026-08-15T08-28-06 and
 * .omo/evidence/review-remediation/task-9/audit.csv.
 *
 * Exit 0 when the round-2-verified self-check values reproduce exactly
 * (B1 n=6037; B2 n=3018; B6a n=6042 pos=2578); exit 1 otherwise — a mismatch
 * means row-vs-sample extraction is wrong, not that the chapter should change.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SWEEP = process.argv[2] ?? 'results/baseline-sweep-2026-08-15T08-28-06';
const OUT = process.argv[3] ?? '.omo/evidence/review-remediation/task-9/audit.csv';

interface Overall { tp: number; fp: number; fn: number; tn: number; total: number }
interface Metrics { overall: Overall; rows: Array<Record<string, number>>; samples: unknown[] }

// Pinned per-config metrics.json: single-run configs live at the top level,
// multi-run configs are read from run-1 (matches the printed CI column).
const CONFIGS: Array<{ id: string; path: string }> = [
  { id: 'B1', path: 'B1/metrics.json' },
  { id: 'B2', path: 'B2/metrics.json' },
  { id: 'B3', path: 'B3/metrics.json' },
  { id: 'B4', path: 'B4/run-1/metrics.json' },
  { id: 'B5', path: 'B5/run-1/metrics.json' },
  { id: 'B6', path: 'B6/run-1/metrics.json' },
  { id: 'B6a', path: 'B6a/run-1/metrics.json' },
  { id: 'B6b', path: 'B6b/run-1/metrics.json' },
  { id: 'B7', path: 'B7/run-1/metrics.json' },
];

const rows: string[] = ['config,n_samples,pos_space,tp,fp,fn,tn,precision_printed'];

for (const { id, path } of CONFIGS) {
  const m: Metrics = JSON.parse(readFileSync(join(SWEEP, path), 'utf-8'));
  const { tp, fp, fn, tn } = m.overall;
  const n = m.samples.length;
  const pos = tp + fn;

  // Internal consistency: the stored total and the per-case rows must both
  // reproduce the per-site sample count, else the extraction is wrong.
  if (m.overall.total !== n) {
    console.error(`FAIL ${id}: overall.total=${m.overall.total} != samples.length=${n}`);
    process.exit(1);
  }
  const rowCells = m.rows.reduce((acc, r) => acc + (r.tp ?? 0) + (r.fp ?? 0) + (r.fn ?? 0) + (r.tn ?? 0), 0);
  if (rowCells !== n) {
    console.error(`FAIL ${id}: sum(rows tp+fp+fn+tn)=${rowCells} != samples.length=${n}`);
    process.exit(1);
  }

  const precision = tp + fp > 0 ? (tp / (tp + fp)).toFixed(3) : 'NA';
  rows.push(`${id},${n},${pos},${tp},${fp},${fn},${tn},${precision}`);
  console.log(
    `${id}: n=${n} pos_space=${pos} tp=${tp} fp=${fp} fn=${fn} tn=${tn} precision_printed=${precision}`,
  );
}

// Round-2-verified anchors: if these drift, the extraction is wrong — fix the
// script before touching the chapter.
const byId = new Map(rows.slice(1).map((r) => [r.split(',')[0], r.split(',').map(Number)]));
const expect: Array<[string, number, number, number]> = [
  ['B1', 6037, 2578, 6037],
  ['B2', 3018, 3018, 3018],
  ['B6a', 6042, 2578, 6042],
];
for (const [id, n, pos, nOut] of expect) {
  const r = byId.get(id);
  if (!r || r[1] !== n || r[2] !== pos || r[1] !== nOut) {
    console.error(`FAIL self-check ${id}: got [${r?.join(',')}] expected n=${n} pos=${pos}`);
    process.exit(1);
  }
}
console.log('self-check OK: B1 n=6037, B2 n=3018, B6a n=6042 pos=2578');

mkdirSync(join(OUT, '..'), { recursive: true });
writeFileSync(OUT, rows.join('\n') + '\n');
console.log(`wrote ${OUT} (${rows.length - 1} config rows)`);
