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
 * Exit codes: 0 = deterministic · 1 = non-deterministic (diff shown) · 2 = INVALID
 * gate (refused to certify — see below).
 *
 * A determinism gate is only meaningful if the runs actually DID something distinct.
 * Two failure modes silently produce a bogus "✓ deterministic" and are explicitly
 * rejected here (each was hit for real while bringing this gate up):
 *   - self-compare: both paths resolve to the same file (e.g. a coarse second-
 *     granularity output stamp collided for two fast runs) → a dir compared to itself.
 *   - degenerate run: zero cases, an all-zero confusion matrix, or ANY errored case
 *     (e.g. "analyzer unreachable") → two identical piles of nothing.
 */

import { readFileSync, realpathSync } from 'node:fs';

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
    // Canonicalize key order so {heuristic:2,llm:2} == {llm:2,heuristic:2}.
    judgePathDistribution: Object.fromEntries(Object.entries(r.judgePathDistribution ?? {}).sort()),
    rows,
  };
}

const [pathA, pathB] = process.argv.slice(2);
if (!pathA || !pathB) {
  console.error('usage: bun scripts/assert-determinism.ts <runA>/metrics.json <runB>/metrics.json');
  process.exit(2);
}

/** Refuse the gate (exit 2) — distinct from a real non-deterministic FAIL (exit 1). */
function invalid(msg: string): never {
  console.error(`✗ INVALID GATE — refusing to certify determinism.\n  ${msg}`);
  process.exit(2);
}

// Guard 1: a dir compared to itself always "passes". Reject same-file inputs.
try {
  if (realpathSync(pathA) === realpathSync(pathB)) {
    invalid(
      `both inputs resolve to the SAME file:\n    ${realpathSync(pathA)}\n` +
        `  The two runs must write to DISTINCT output dirs (point RESULTS_DIR at separate paths).`,
    );
  }
} catch {
  /* if realpath fails, fall through — the read below will surface a clearer error */
}

const rawA = JSON.parse(readFileSync(pathA, 'utf-8'));
const rawB = JSON.parse(readFileSync(pathB, 'utf-8'));

// Guard 2: a degenerate run (no cases / all-zero / any errored case) is not
// evidence of determinism — two identical piles of nothing trivially match.
function assertHealthy(r: any, label: string): void {
  const rows: any[] = r.rows ?? [];
  if (rows.length === 0) invalid(`${label} scored 0 cases — nothing to certify.`);
  const errored = rows.filter((x) => x.status === 'error');
  if (errored.length > 0) {
    invalid(
      `${label} has ${errored.length}/${rows.length} ERRORED case(s) — e.g. "${(errored[0].error ?? 'unknown').slice(0, 90)}".\n` +
        `  Fix the environment (are the analyzer MCP servers reachable?) before asserting determinism.`,
    );
  }
  if ((r.overall?.total ?? 0) === 0) invalid(`${label} produced an all-zero confusion matrix (total=0) — degenerate run.`);
}
assertHealthy(rawA, 'run A');
assertHealthy(rawB, 'run B');

const a = stableSubset(rawA);
const b = stableSubset(rawB);
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
