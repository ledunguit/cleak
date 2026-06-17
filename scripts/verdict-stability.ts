#!/usr/bin/env bun
/**
 * Verdict-stability report (Tier-2 reproducibility) — quantifies the run-to-run
 * nondeterminism of an LLM-judged eval HONESTLY instead of hiding it.
 *
 * The determinism gate (assert-determinism.ts) demands byte-identical scoring and
 * is the right bar for the deterministic no_llm pipeline. An llm_assisted run will
 * NOT clear it — the LLM judge flips borderline verdicts even at temp=0. This tool
 * measures HOW MUCH it flips across ≥2 independent runs of the same config:
 *
 *   bun scripts/verdict-stability.ts <runA>[/metrics.json] <runB> [<runC> ...]
 *
 * Per case we form the confusion signature (tp,fp,fn,tn). A case is STABLE iff that
 * signature is identical in every run; otherwise it FLIPPED. We report the
 * case-level flip rate, the modal agreement (for N>2), and — importantly — whether
 * the AGGREGATE confusion is stable even while cases flip (the headline pathology:
 * aggregate numbers can look reproducible by luck while individual verdicts churn,
 * which is exactly why a case-level metric is needed and why the consensus judge,
 * which votes over k samples, is the fix).
 *
 * Exit 0 (it is a report). Exits 2 if a run is degenerate (errored/empty) — those
 * cannot be interpreted.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: bun scripts/verdict-stability.ts <runA> <runB> [<runC> ...]   (dir or metrics.json)');
  process.exit(2);
}

const metricsPath = (p: string) => {
  try {
    return statSync(p).isDirectory() ? join(p, 'metrics.json') : p;
  } catch {
    return p;
  }
};
const runs = args.map((p) => JSON.parse(readFileSync(metricsPath(p), 'utf-8')));

// Refuse to interpret degenerate runs (mirror the determinism gate's guard).
runs.forEach((r, i) => {
  const rows: any[] = r.rows ?? [];
  if (rows.length === 0) {
    console.error(`✗ run ${i + 1} (${args[i]}) scored 0 cases.`);
    process.exit(2);
  }
  const errored = rows.filter((x) => x.status === 'error');
  if (errored.length) {
    console.error(`✗ run ${i + 1} (${args[i]}) has ${errored.length}/${rows.length} errored case(s) — e.g. "${(errored[0].error ?? '').slice(0, 80)}". Cannot interpret stability.`);
    process.exit(2);
  }
});

const sig = (x: any) => `${x.tp},${x.fp},${x.fn},${x.tn}`;
const N = runs.length;

// Intersect case ids present in every run.
const idSets = runs.map((r) => new Set((r.rows as any[]).map((x) => x.id)));
const ids = [...idSets[0]].filter((id) => idSets.every((s) => s.has(id))).sort();
const byRun = runs.map((r) => new Map((r.rows as any[]).map((x) => [x.id, x])));

let stable = 0;
const flipped: Array<{ id: string; sigs: string[]; modal: number }> = [];
for (const id of ids) {
  const sigs = byRun.map((m) => sig(m.get(id)));
  const counts = new Map<string, number>();
  for (const s of sigs) counts.set(s, (counts.get(s) ?? 0) + 1);
  const modal = Math.max(...counts.values());
  if (counts.size === 1) stable++;
  else flipped.push({ id, sigs, modal });
}

// Aggregate-confusion stability across runs (the "stable by luck" check).
const aggSig = (r: any) => sig(r.overall);
const aggStable = runs.every((r) => aggSig(r) === aggSig(runs[0]));
const meanModalAgreement = ids.length ? ids.reduce((acc, id) => {
  const counts = new Map<string, number>();
  for (const m of byRun) { const s = sig(m.get(id)); counts.set(s, (counts.get(s) ?? 0) + 1); }
  return acc + Math.max(...counts.values()) / N;
}, 0) / ids.length : 1;

const flipRate = ids.length ? flipped.length / ids.length : 0;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`Verdict stability over ${N} runs · ${ids.length} shared cases\n`);
console.log(`  case-level stability : ${stable}/${ids.length} (${pct(stable / ids.length)})`);
console.log(`  verdict flip rate    : ${flipped.length}/${ids.length} (${pct(flipRate)})`);
console.log(`  mean modal agreement : ${pct(meanModalAgreement)}  (1.0 = every run agrees per case)`);
console.log(`  aggregate confusion  : ${aggStable ? 'IDENTICAL across runs' : 'differs across runs'}` +
  `${aggStable && flipped.length ? '  ⚠ stable-by-luck — per-case verdicts churn while the sum cancels out' : ''}`);
console.log(`  per run overall      : ${runs.map((r) => sig(r.overall)).join('  |  ')}   (tp,fp,fn,tn)`);

if (flipped.length) {
  console.log(`\n  flipped cases (signature per run):`);
  for (const f of flipped.slice(0, 20)) {
    console.log(`    ${f.id.replace(/^CWE\d+_[A-Za-z_]+__/, '')}: ${f.sigs.join('  →  ')}`);
  }
  if (flipped.length > 20) console.log(`    … +${flipped.length - 20} more`);
}
