#!/usr/bin/env -S tsx
/**
 * Confidence-cutoff sweep over PERSISTED verdicts (thesis review remediation I4).
 *
 * Re-scores each baseline-sweep config under flag(c) = isFlagged(verdict) ∧ (confidence ≥ c):
 * every finding that was flagged but carries confidence below the cutoff c gets its
 * verdict replaced by a NON-flagged verdict (`false_positive`), then the production
 * scorer (`scoreCase`) + production metric aggregation (`accumulate`/`computeMetrics`
 * from `@cleak/common/analysis/metrics`) produce P/R/F1 exactly as the eval pipeline
 * does. This is an OFFLINE re-thresholding of stored per-case findings — it does NOT
 * sweep the heuristic judge's internal score cutoffs (0.7/0.4): the raw judge scores
 * were never persisted, so those are future work.
 *
 * The flag source is the per-case `findings` array (each finding carries `verdict` +
 * `confidence`), NOT the `samples` arrays in metrics.json — samples carry no verdict
 * and their confidence is verdict-DIRECTIONAL (confident-clean findings also have
 * high confidence), so a samples-only sweep measures the wrong quantity (round-1
 * review falsification: B6a F1 0.466 instead of 0.863 at c=0.7).
 *
 * SELF-TEST (anti-fabrication): at c = 0.0 the transform is an exact no-op — scoreCase
 * derives `predicted` from isFlagged(f.verdict) with site-level OR — so each config's
 * c = 0.0 row MUST equal its stored metrics.json `overall` P/R/F1 within ±0.001. Any
 * mismatch is a hard failure (exit 1, full diff printed; stored numbers are never modified).
 *
 *   pnpm exec tsx scripts/threshold-sweep.ts
 *
 * Writes paper/figures/threshold-sweep.csv: config,c,precision,recall,f1,fpPerKloc
 * (fpPerKloc = fp / Σ loc(status=ok) × 1000, same definition as the eval harness).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accumulate, computeMetrics } from '@cleak/common/analysis/metrics';
import { LEAK_POSITIVE_VERDICTS } from '@cleak/common/analysis/judge-shared';
import {
  scoreCase,
  isFlagged,
  type LabeledCase,
  type SnapshotFinding,
} from '../apps/leak-inspector-tui/src/domain/evalScoring';

const SWEEP_ROOT = 'results/baseline-sweep-2026-08-15T08-28-06';
const MANIFEST_PATH = 'demo/juliet_cwe401/corpus_manifest.json';
const CSV_PATH = 'paper/figures/threshold-sweep.csv';
const TOLERANCE = 0.001;

/** Non-flagged replacement verdict — in LEAK_VERDICT_STRINGS, NOT in LEAK_POSITIVE_VERDICTS. */
const UNFLAGGED_VERDICT = 'false_positive';

interface Config {
  name: string;
  casesDir: string;
  metricsPath: string;
}

const CONFIGS: Config[] = [
  { name: 'B1', casesDir: join(SWEEP_ROOT, 'B1', 'cases'), metricsPath: join(SWEEP_ROOT, 'B1', 'metrics.json') },
  { name: 'B6a', casesDir: join(SWEEP_ROOT, 'B6a', 'run-1', 'cases'), metricsPath: join(SWEEP_ROOT, 'B6a', 'run-1', 'metrics.json') },
  { name: 'B6', casesDir: join(SWEEP_ROOT, 'B6', 'run-1', 'cases'), metricsPath: join(SWEEP_ROOT, 'B6', 'run-1', 'metrics.json') },
];

const CUTOFFS: number[] = Array.from({ length: 11 }, (_, i) => i / 10);

const f3 = (x: number) => x.toFixed(3);

interface CaseFile {
  id: string;
  findings: SnapshotFinding[];
  row: { loc?: number; status?: string };
}

/** Load one config's per-case JSONs. Returns null (BLOCKED) if findings are absent. */
function loadCases(cfg: Config): { cases: CaseFile[] } | { blocked: string } {
  if (!existsSync(cfg.casesDir)) return { blocked: `cases dir not found: ${cfg.casesDir}` };
  const files = readdirSync(cfg.casesDir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) return { blocked: `no case files in ${cfg.casesDir}` };
  const cases: CaseFile[] = [];
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(cfg.casesDir, f), 'utf-8'));
    if (!d || !Array.isArray(d.findings)) return { blocked: `case ${f} has no findings array` };
    cases.push({ id: d.id, findings: d.findings, row: d.row ?? {} });
  }
  return { cases };
}

/**
 * flag(c): a flagged finding whose confidence fails the cutoff is demoted to a
 * non-flagged verdict. Missing/undefined confidence counts as 0 — fails `>= c`
 * for every c > 0, passes at c = 0.0 (keeping the c=0.0 anchor an exact no-op).
 * scoreCase's site-level OR then re-derives the site prediction.
 */
function rethreshold(findings: SnapshotFinding[], c: number): SnapshotFinding[] {
  return findings.map((f) =>
    isFlagged(f.verdict) && !(Number(f.confidence ?? 0) >= c) ? { ...f, verdict: UNFLAGGED_VERDICT } : f,
  );
}

function main(): void {
  if (LEAK_POSITIVE_VERDICTS.has(UNFLAGGED_VERDICT)) {
    throw new Error(`${UNFLAGGED_VERDICT} is a POSITIVE verdict in this codebase — pick another replacement`);
  }
  if (!existsSync(MANIFEST_PATH)) throw new Error(`corpus manifest not found: ${MANIFEST_PATH}`);

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  const labeledById = new Map<string, LabeledCase>((manifest.cases ?? []).map((c: LabeledCase) => [c.id, c]));

  const csvLines: string[] = ['config,c,precision,recall,f1,fpPerKloc'];
  const failed: string[] = [];
  const configsWritten: string[] = [];

  for (const cfg of CONFIGS) {
    const loaded = loadCases(cfg);
    if ('blocked' in loaded) {
      console.log(`⊘ ${cfg.name}: BLOCKED — ${loaded.blocked}`);
      continue;
    }
    const stored = JSON.parse(readFileSync(cfg.metricsPath, 'utf-8'));
    const expected = stored.overall;
    const totalLoc = loaded.cases.reduce((a, c) => a + (c.row.status === 'ok' ? c.row.loc ?? 0 : 0), 0);
    const allFlagged = loaded.cases.reduce((a, k) => a + k.findings.filter((f) => isFlagged(f.verdict)).length, 0);

    console.log(`▶ ${cfg.name}: ${loaded.cases.length} cases, stored overall P/R/F1 = ${f3(expected.precision)}/${f3(expected.recall)}/${f3(expected.f1)}, flagged findings = ${allFlagged}`);

    let prevFlagged = Infinity;
    for (const c of CUTOFFS) {
      const samples = loaded.cases.flatMap((k) => {
        const labeled = labeledById.get(k.id);
        if (!labeled) throw new Error(`case ${k.id} missing from ${MANIFEST_PATH}`);
        return scoreCase(rethreshold(k.findings, c), labeled);
      });
      const m = computeMetrics(accumulate(samples));
      const fpPerKloc = totalLoc > 0 ? (m.fp / totalLoc) * 1000 : 0;
      const flagged = loaded.cases.reduce(
        (a, k) => a + k.findings.filter((f) => isFlagged(f.verdict) && Number(f.confidence ?? 0) >= c).length,
        0,
      );
      if (flagged > prevFlagged) console.log(`  ! warning: flagged count rose ${prevFlagged}→${flagged} at c=${c.toFixed(1)} (expected monotone)`);
      prevFlagged = flagged;

      if (c === 0.0) {
        const diffs = [
          ['precision', m.precision, expected.precision],
          ['recall', m.recall, expected.recall],
          ['f1', m.f1, expected.f1],
        ] as const;
        const bad = diffs.filter(([, got, want]) => Math.abs(got - want) > TOLERANCE);
        if (bad.length === 0) {
          console.log(`  ✓ SELF-TEST c=0.0 vs stored metrics.json: PASSED (P ${f3(m.precision)} R ${f3(m.recall)} F1 ${f3(m.f1)}, matrix ${m.tp}/${m.fp}/${m.fn}/${m.tn})`);
        } else {
          const detail = bad.map(([k, got, want]) => `${k}: got ${got.toFixed(6)} want ${want.toFixed(6)} (Δ ${Math.abs(got - want).toFixed(6)})`).join('; ');
          console.log(`  ✗ SELF-TEST c=0.0 vs stored metrics.json: FAILED — ${detail}`);
          failed.push(`${cfg.name} c=0.0 self-test: ${detail}`);
        }
      }
      csvLines.push(`${cfg.name},${c.toFixed(1)},${f3(m.precision)},${f3(m.recall)},${f3(m.f1)},${f3(fpPerKloc)}`);
    }
    configsWritten.push(cfg.name);
    console.log(`  sweep done: flagged ${allFlagged} → ${prevFlagged} across c = 0.0 → 1.0`);
  }

  if (failed.length > 0) {
    console.error(`\nFATAL: ${failed.length} self-test failure(s) — refusing to write ${CSV_PATH}:\n  - ${failed.join('\n  - ')}`);
    process.exit(1);
  }
  if (configsWritten.length === 0) {
    console.error('\nFATAL: every config was BLOCKED — nothing to write.');
    process.exit(1);
  }
  mkdirSync('paper/figures', { recursive: true });
  writeFileSync(CSV_PATH, csvLines.join('\n') + '\n');
  console.log(`\n✓ wrote ${csvLines.length - 1} rows × ${configsWritten.length} configs (${configsWritten.join(', ')}) → ${CSV_PATH}`);
  if (configsWritten.length < CONFIGS.length) {
    console.log(`  (${CONFIGS.length - configsWritten.length} config(s) BLOCKED — see ⊘ lines above)`);
  }
}

main();
