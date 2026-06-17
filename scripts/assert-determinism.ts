#!/usr/bin/env bun
/**
 * Determinism gate — the whole point of the dynamic-evidence rework. Asserts that
 * two eval runs of the SAME config produced byte-identical SCORING results (the
 * confusion matrix + per-variant metrics + per-case rows), ignoring timestamps,
 * durations, tokens, and provenance. Before the rework this FAILS (the LLM dynamic
 * worker non-deterministically recorded evidence, flipping verdicts run-to-run);
 * after it, this PASSES.
 *
 *   bun scripts/assert-determinism.ts <runA>/metrics.json <runB>/metrics.json
 *
 * Exits 0 if deterministic, 1 with a diff otherwise.
 */

import { readFileSync } from 'node:fs';

const cm = (m: any) => (m ? { tp: m.tp, fp: m.fp, fn: m.fn, tn: m.tn } : null);

/** The scoring-relevant, time-independent subset of a metrics.json (EvalResult). */
function stableSubset(r: any) {
  const byKey = (obj: Record<string, any> = {}) =>
    Object.fromEntries(Object.keys(obj).sort().map((k) => [k, cm(obj[k])]));
  const rows = (r.rows ?? [])
    .map((x: any) => ({ id: x.id, status: x.status, tp: x.tp, fp: x.fp, fn: x.fn, tn: x.tn }))
    .sort((a: any, b: any) => a.id.localeCompare(b.id));
  return {
    overall: cm(r.overall),
    byFlowVariant: byKey(r.byFlowVariant),
    byFunctionalVariant: byKey(r.byFunctionalVariant),
    byCwe: byKey(r.byCwe),
    judgePathDistribution: r.judgePathDistribution ?? {},
    rows,
  };
}

const [pathA, pathB] = process.argv.slice(2);
if (!pathA || !pathB) {
  console.error('usage: bun scripts/assert-determinism.ts <runA>/metrics.json <runB>/metrics.json');
  process.exit(2);
}

const a = stableSubset(JSON.parse(readFileSync(pathA, 'utf-8')));
const b = stableSubset(JSON.parse(readFileSync(pathB, 'utf-8')));
const sa = JSON.stringify(a, null, 2);
const sb = JSON.stringify(b, null, 2);

if (sa === sb) {
  console.log('✓ DETERMINISTIC — the two runs produced identical scoring results.');
  console.log(`  overall: ${JSON.stringify(a.overall)} · judgePath: ${JSON.stringify(a.judgePathDistribution)}`);
  process.exit(0);
}

console.error('✗ NON-DETERMINISTIC — the two runs differ on scoring-relevant fields:\n');
// Show the first differing per-case rows for a quick diagnosis.
const rowsA = new Map(a.rows.map((r: any) => [r.id, r]));
let shown = 0;
for (const rb of b.rows as any[]) {
  const ra = rowsA.get(rb.id);
  if (JSON.stringify(ra) !== JSON.stringify(rb) && shown < 10) {
    console.error(`  ${rb.id}:`);
    console.error(`    A: ${JSON.stringify(ra)}`);
    console.error(`    B: ${JSON.stringify(rb)}`);
    shown++;
  }
}
if (JSON.stringify(a.overall) !== JSON.stringify(b.overall)) {
  console.error(`  overall  A: ${JSON.stringify(a.overall)}  B: ${JSON.stringify(b.overall)}`);
}
process.exit(1);
