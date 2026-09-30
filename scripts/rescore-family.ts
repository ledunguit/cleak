/**
 * Todo 10 — per-family (functionalVariant) fixed-universe aggregation for one
 * sweep config over its runs. Sibling of rescore-universe.ts (same universe
 * construction, asserted against the census).
 *
 *   tsx scripts/rescore-family.ts <configDir>   e.g. results/baseline-sweep-2026-08-15T08-28-06/B6a
 *
 * Prints per-family cases/sites/per-run TP-FP-FN-TN and mean P/R/F1 across runs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { accumulate, computeMetrics, type Sample } from '../packages/common/src/analysis/metrics';
import {
  buildCaseUniverse,
  scoreCaseUniverse,
  type SnapshotFinding,
} from '../apps/leak-inspector-tui/src/domain/evalScoring';

const ROOT = join(dirname(resolve(process.argv[1] ?? '')), '..');
const configDir = process.argv[2];
if (!configDir) throw new Error('usage: tsx scripts/rescore-family.ts <configDir>');

const manifest = JSON.parse(readFileSync(join(ROOT, 'demo/juliet_cwe401/corpus_manifest.json'), 'utf-8')) as {
  cases: Array<{ id: string; functionalVariant?: string; flaws?: Array<{ function: string }>; clean?: Array<{ function: string }> }>;
};
const census = JSON.parse(readFileSync(join(ROOT, '.omo/evidence/scoring-universe-refactor/universe-census.json'), 'utf-8')) as {
  merged: { bad: number; good: number; total: number };
  perCaseSites: Record<string, { bad: string[]; good: string[] }>;
};

const familyOf = new Map<string, string>();
const universes = new Map<string, { bad: ReturnType<typeof buildCaseUniverse>['bad']; good: ReturnType<typeof buildCaseUniverse>['good'] }>();
let badTotal = 0, goodTotal = 0;
for (const c of manifest.cases) {
  const fam = c.functionalVariant ?? 'unknown';
  familyOf.set(c.id, fam);
  const u = buildCaseUniverse({
    bad: (c.flaws ?? []).map((f) => f.function),
    good: (c.clean ?? []).map((f) => f.function),
  });
  const sorted = (xs: string[]) => [...xs].sort();
  const keys = (cls: 'bad' | 'good') => sorted(u[cls].map((s) => `${c.id}::${s.site}`));
  const exp = census.perCaseSites[c.id];
  if (JSON.stringify(keys('bad')) !== JSON.stringify(sorted(exp.bad)) ||
      JSON.stringify(keys('good')) !== JSON.stringify(sorted(exp.good))) {
    throw new Error(`universe drift vs census for ${c.id}`);
  }
  badTotal += u.bad.length;
  goodTotal += u.good.length;
  universes.set(c.id, u);
}
if (badTotal !== census.merged.bad || goodTotal !== census.merged.good) throw new Error('census totals drift');
console.log(`universe ok: ${badTotal} bad + ${goodTotal} good (== census)`);

const runDirs = readdirSync(configDir).filter((d) => /^run-\d+$/.test(d)).sort();
const perRunFamily = new Map<string, Map<string, { tp: number; fp: number; fn: number; tn: number; cases: Set<string>; fnCases: Set<string> }>>();
const familyCases = new Map<string, Set<string>>();
const familySites = new Map<string, number>();

for (const run of runDirs.length ? runDirs : ['flat']) {
  const caseDir = join(configDir, run, 'cases');
  const famMap = new Map<string, { tp: number; fp: number; fn: number; tn: number; cases: Set<string>; fnCases: Set<string> }>();
  perRunFamily.set(run, famMap);
  for (const f of readdirSync(caseDir).sort()) {
    if (!f.endsWith('.json')) continue;
    const cached = JSON.parse(readFileSync(join(caseDir, f), 'utf-8')) as {
      id: string; row: { status: string }; findings: SnapshotFinding[];
    };
    if (cached.row.status !== 'ok') continue;
    const fam = familyOf.get(cached.id)!;
    const u = universes.get(cached.id)!;
    const r = scoreCaseUniverse(cached.findings ?? [], cached.id, u);
    let agg = famMap.get(fam);
    if (!agg) { agg = { tp: 0, fp: 0, fn: 0, tn: 0, cases: new Set(), fnCases: new Set() }; famMap.set(fam, agg); }
    for (const s of r.samples) {
      if (s.actual && s.predicted) agg.tp++;
      else if (!s.actual && s.predicted) agg.fp++;
      else if (s.actual && !s.predicted) { agg.fn++; agg.fnCases.add(cached.id); }
      else agg.tn++;
    }
    agg.cases.add(cached.id);
    if (!familyCases.has(fam)) familyCases.set(fam, new Set());
    familyCases.get(fam)!.add(cached.id);
  }
}

for (const [fam, s] of [...familyCases.entries()].sort()) {
  familySites.set(fam, 0);
  for (const id of s) familySites.set(fam, (familySites.get(fam) ?? 0) + universes.get(id)!.bad.length + universes.get(id)!.good.length);
}

console.log('\nfamily | cases | sites | per-run TP/FP/FN/TN | mean P | mean R | mean F1');
const rows: string[] = [];
for (const [fam] of [...familyCases.entries()].sort()) {
  const runs = [...perRunFamily.entries()].sort();
  const ps: number[] = [], rs: number[] = [], fs: number[] = [];
  const cells: string[] = [];
  let cases = 0, sites = 0;
  for (const [run, famMap] of runs) {
    const agg = famMap.get(fam);
    if (!agg) continue;
    const cm = computeMetrics(accumulate((agg.tp ? [] : []) as Sample[])); // placeholder no-op
    void cm;
    const m = { tp: agg.tp, fp: agg.fp, fn: agg.fn, tn: agg.tn };
    const total = m.tp + m.fp + m.fn + m.tn;
    const precision = total ? m.tp / (m.tp + m.fp || 1) : 0;
    const recall = m.tp + m.fn ? m.tp / (m.tp + m.fn) : 0;
    const p = m.tp + m.fp ? m.tp / (m.tp + m.fp) : 0;
    const r = m.tp + m.fn ? m.tp / (m.tp + m.fn) : 0;
    const f1 = p + r ? (2 * p * r) / (p + r) : 0;
    void precision; void recall;
    ps.push(p); rs.push(r); fs.push(f1);
    cells.push(`${m.tp}/${m.fp}/${m.fn}/${m.tn}`);
    cases = agg.cases.size;
    sites = familySites.get(fam) ?? 0;
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const row = `${fam} | ${cases} | ${sites} | ${cells.join(' ; ')} | ${mean(ps).toFixed(3)} | ${mean(rs).toFixed(3)} | ${mean(fs).toFixed(3)}`;
  rows.push(row);
  console.log(row);
}
void rows;
