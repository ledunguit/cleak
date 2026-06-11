#!/usr/bin/env bun
/**
 * Side-by-side comparison of two or more eval runs — the table the thesis uses
 * to contrast modes (no_llm vs llm_assisted = the LLM-agent ablation) and, once
 * baseline adapters exist, external tools (clang scan-build / valgrind alone).
 * Reads the `metrics.json` written by the eval harness (an EvalResult) from each
 * given path (a metrics.json file OR a directory containing one) and emits a
 * Markdown + LaTeX comparison to stdout (or --out <file>).
 *
 *   bun scripts/compare-results.ts results/eval-no_llm-* results/eval-llm_assisted-*
 *   bun scripts/compare-results.ts a/metrics.json b/metrics.json --out results/compare.md
 *   bun scripts/compare-results.ts --label "Heuristic" a/ --label "LLM" b/
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

interface Metricsish {
  total: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  specificity: number;
  mcc: number;
}

interface EvalResultish {
  mode?: string;
  dynamic?: string;
  ranOk?: number;
  caseCount?: number;
  ece?: number;
  overall?: Metricsish;
  provenance?: { model?: string; provider?: string; temperature?: number; runs?: number; gitCommit?: string };
}

interface Loaded {
  label: string;
  r: EvalResultish;
}

function resolveMetricsPath(p: string): string {
  if (existsSync(p) && statSync(p).isDirectory()) return join(p, 'metrics.json');
  return p;
}

/** Parse argv into (path, optional --label) pairs and flags. */
function parseArgs(): { items: Array<{ path: string; label?: string }>; out?: string } {
  const items: Array<{ path: string; label?: string }> = [];
  let out: string | undefined;
  let pendingLabel: string | undefined;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      out = argv[++i];
    } else if (a === '--label') {
      pendingLabel = argv[++i];
    } else {
      items.push({ path: a, label: pendingLabel });
      pendingLabel = undefined;
    }
  }
  return { items, out };
}

function autoLabel(path: string, r: EvalResultish): string {
  const mode = r.mode ?? 'unknown';
  const dyn = r.dynamic && r.dynamic !== 'off' ? `+${r.dynamic}` : '';
  const model = r.provenance?.model ? ` (${r.provenance.model})` : '';
  // Fall back to a directory hint when mode is absent.
  if (mode === 'unknown') return basename(dirname(resolveMetricsPath(path)));
  return `${mode}${dyn}${model}`;
}

const { items, out } = parseArgs();
if (items.length < 2) {
  console.error('usage: bun scripts/compare-results.ts <metrics.json|dir> <metrics.json|dir> [...] [--label L]* [--out file]');
  process.exit(2);
}

const loaded: Loaded[] = items.map(({ path, label }) => {
  const mp = resolveMetricsPath(path);
  const r = JSON.parse(readFileSync(mp, 'utf-8')) as EvalResultish;
  return { label: label ?? autoLabel(path, r), r };
});

const f3 = (x: number | undefined) => (x ?? 0).toFixed(3);
const pctOf = (x: number | undefined) => `${((x ?? 0) * 100).toFixed(1)}%`;

const ROWS: Array<{ name: string; get: (r: EvalResultish) => string }> = [
  { name: 'Cases scored', get: (r) => `${r.ranOk ?? '?'}/${r.caseCount ?? '?'}` },
  { name: 'Precision', get: (r) => `${f3(r.overall?.precision)} (${pctOf(r.overall?.precision)})` },
  { name: 'Recall', get: (r) => `${f3(r.overall?.recall)} (${pctOf(r.overall?.recall)})` },
  { name: 'F1', get: (r) => f3(r.overall?.f1) },
  { name: 'Accuracy', get: (r) => f3(r.overall?.accuracy) },
  { name: 'Specificity', get: (r) => f3(r.overall?.specificity) },
  { name: 'MCC', get: (r) => f3(r.overall?.mcc) },
  { name: 'ECE', get: (r) => f3(r.ece) },
  { name: 'TP/FP/FN/TN', get: (r) => `${r.overall?.tp ?? 0}/${r.overall?.fp ?? 0}/${r.overall?.fn ?? 0}/${r.overall?.tn ?? 0}` },
  { name: 'Model', get: (r) => r.provenance?.model ?? '—' },
  { name: 'Temp', get: (r) => String(r.provenance?.temperature ?? '—') },
  { name: 'Runs', get: (r) => String(r.provenance?.runs ?? 1) },
  { name: 'Commit', get: (r) => r.provenance?.gitCommit?.slice(0, 8) ?? '—' },
];

function markdown(): string {
  const header = `| Metric | ${loaded.map((l) => l.label).join(' | ')} |`;
  const sep = `|---|${loaded.map(() => '--:').join('|')}|`;
  const body = ROWS.map((row) => `| ${row.name} | ${loaded.map((l) => row.get(l.r)).join(' | ')} |`);
  return ['# Eval comparison', '', header, sep, ...body, ''].join('\n');
}

const texEsc = (s: string) => s.replace(/[_&%#$]/g, (c) => `\\${c}`);

function latex(): string {
  const cols = 'l' + 'r'.repeat(loaded.length);
  const header = `Metric & ${loaded.map((l) => texEsc(l.label)).join(' & ')} \\\\`;
  // A compact headline subset for the dissertation table.
  const keep = new Set(['Precision', 'Recall', 'F1', 'Accuracy', 'MCC', 'ECE']);
  const body = ROWS.filter((r) => keep.has(r.name)).map(
    (row) => `${row.name} & ${loaded.map((l) => texEsc(row.get(l.r))).join(' & ')} \\\\`,
  );
  return [
    '\\begin{table}[h]\\centering',
    '\\caption{Detection metrics by configuration}',
    `\\begin{tabular}{${cols}}`,
    '\\toprule',
    header,
    '\\midrule',
    ...body,
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}',
  ].join('\n');
}

const output = `${markdown()}\n\n\`\`\`latex\n${latex()}\n\`\`\`\n`;
if (out) {
  writeFileSync(out, output);
  console.log(`✓ wrote ${out}`);
} else {
  process.stdout.write(output);
}
