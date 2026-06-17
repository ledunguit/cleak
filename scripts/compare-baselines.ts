#!/usr/bin/env bun
/**
 * Head-to-head baseline comparison (thesis Table 3). Runs every AVAILABLE external
 * baseline (clang-analyzer, infer) over the same corpus, scored by the same
 * `scoreCase` as our system, and prints one table. Optionally folds in our own
 * runs by reading their `metrics.json` (an EvalResult) so heuristic / single-LLM /
 * consensus sit in the same table as the baselines — every number from one
 * scoring definition on one corpus, which is what makes the comparison defensible.
 *
 *   bun scripts/compare-baselines.ts --corpus demo/juliet_cwe401
 *   bun scripts/compare-baselines.ts --corpus demo/juliet_cwe401 --limit 8 \
 *       --system heuristic=/tmp/p0-all30/metrics.json \
 *       --system consensus=/tmp/p0-consensus/metrics.json \
 *       --out results/baseline-compare
 *
 * Baselines whose tool is not installed are listed as SKIPPED (never faked).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClangAnalyzerAdapter } from '../apps/leak-inspector-tui/src/domain/baselines/clangAnalyzer';
import { InferAdapter } from '../apps/leak-inspector-tui/src/domain/baselines/infer';
import { runBaselineEval, type BaselineResult } from '../apps/leak-inspector-tui/src/domain/baselines/runBaselineEval';
import type { BaselineAdapter } from '../apps/leak-inspector-tui/src/domain/baselines/adapter';

interface Row {
  tool: string;
  n: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  fpr: number;
  fpPerKloc: number;
  note?: string;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function args(flag: string): string[] {
  const out: string[] = [];
  // `length - 1`: a flag in the LAST position has no value — skip it rather than
  // push `undefined` (which would crash the `spec.indexOf('=')` parse below).
  for (let i = 0; i < process.argv.length - 1; i++) if (process.argv[i] === flag) out.push(process.argv[i + 1]);
  return out;
}

const corpus = arg('--corpus') ?? 'demo/juliet_cwe401';
const limit = arg('--limit') ? parseInt(arg('--limit')!, 10) : undefined;
const outDir = arg('--out');
const systemSpecs = args('--system'); // label=path

const f3 = (x: number) => x.toFixed(3);

function rowFromBaseline(r: BaselineResult): Row {
  const m = r.overall;
  return {
    tool: r.name,
    n: m.total,
    tp: m.tp,
    fp: m.fp,
    fn: m.fn,
    tn: m.tn,
    precision: m.precision,
    recall: m.recall,
    f1: m.f1,
    fpr: m.fpr,
    fpPerKloc: r.fpPerKloc,
    note: `${r.ranOk}/${r.caseCount} cases`,
  };
}

/** Read one of our EvalResult metrics.json files into a comparison row. */
function rowFromSystem(label: string, path: string): Row | null {
  if (!existsSync(path)) {
    console.error(`  ! system metrics not found: ${path}`);
    return null;
  }
  const r = JSON.parse(readFileSync(path, 'utf-8'));
  const m = r.overall;
  const cons = r.provenance?.consensus;
  const judge = cons ? (cons.n > 1 ? `consensus×${cons.n}/${cons.rule}` : 'single-LLM') : r.mode;
  return {
    tool: label,
    n: m.total,
    tp: m.tp,
    fp: m.fp,
    fn: m.fn,
    tn: m.tn,
    precision: m.precision,
    recall: m.recall,
    f1: m.f1,
    fpr: m.fpr,
    fpPerKloc: r.cost?.fpPerKloc ?? 0,
    note: judge,
  };
}

// NOTE on fair columns: a positive-only tool (clang-analyzer, infer) emits ONLY
// leaks, so it never enumerates clean sites → TN=0 by construction, which makes
// FPR / specificity / accuracy / MCC degenerate (FPR≡1) and NOT comparable to a
// candidate-enumerating system. Precision, Recall, F1, the raw FP COUNT, and
// FP/KLOC are the metrics that compare fairly across both (and are what LAMeD /
// MemHint report). We therefore lead with those and omit FPR from the table.
const CAVEAT =
  '> FPR / specificity / MCC are omitted: positive-only baselines (clang, infer) do not enumerate clean sites (TN=0 by construction), so those metrics are not comparable. Precision, Recall, F1, FP count and FP/KLOC are. TN is shown for transparency.';

function renderTable(rows: Row[]): string {
  const head = '| Tool | sites | TP | FP | FN | TN | Precision | Recall | F1 | FP/KLOC | note |';
  const sep = '|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|';
  const body = rows.map(
    (r) =>
      `| ${r.tool} | ${r.n} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.tn} | ${f3(r.precision)} | ${f3(r.recall)} | ${f3(r.f1)} | ${f3(r.fpPerKloc)} | ${r.note ?? ''} |`,
  );
  return [head, sep, ...body].join('\n');
}

function renderCsv(rows: Row[]): string {
  const cols = ['tool', 'n', 'tp', 'fp', 'fn', 'tn', 'precision', 'recall', 'f1', 'fpr', 'fpPerKloc', 'note'];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => String((r as any)[c] ?? '')).join(','));
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  console.log(`Baseline comparison on ${corpus}${limit ? ` (first ${limit} cases)` : ''}\n`);
  const adapters: BaselineAdapter[] = [new ClangAnalyzerAdapter(), new InferAdapter()];
  const rows: Row[] = [];
  const skipped: string[] = [];

  for (const a of adapters) {
    if (!(await a.available())) {
      skipped.push(a.name);
      console.log(`  ⊘ ${a.name}: not installed — SKIPPED (cite published numbers)`);
      continue;
    }
    console.log(`  ▶ ${a.name}: running…`);
    const res = await runBaselineEval(a, corpus, {
      limit,
      onProgress: (d, t, id) => process.stdout.write(`\r    [${d}/${t}] ${id}`.padEnd(60)),
    });
    process.stdout.write('\n');
    rows.push(rowFromBaseline(res));
  }

  for (const spec of systemSpecs) {
    const eq = spec.indexOf('=');
    if (eq < 0) continue;
    const row = rowFromSystem(spec.slice(0, eq), spec.slice(eq + 1));
    if (row) rows.push(row);
  }

  // Order by F1 descending for a readable leaderboard.
  rows.sort((a, b) => b.f1 - a.f1);

  const table = renderTable(rows);
  console.log(`\n${table}\n\n${CAVEAT}\n`);
  if (skipped.length) console.log(`Skipped (not installed): ${skipped.join(', ')}\n`);

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'baseline-compare.md'),
      `# Baseline comparison — ${corpus}\n\n${table}\n\n${CAVEAT}\n\n${skipped.length ? `Skipped (not installed): ${skipped.join(', ')}\n` : ''}`,
    );
    writeFileSync(join(outDir, 'baseline-compare.csv'), renderCsv(rows));
    console.log(`✓ wrote table to ${outDir}`);
  }
}

main().catch((err) => {
  console.error(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
