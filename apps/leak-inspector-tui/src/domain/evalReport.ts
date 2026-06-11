/**
 * Render an EvalResult into thesis-ready artifacts: machine-readable metrics
 * (JSON/CSV), a human-readable Markdown report with confusion matrix + P/R/F1
 * tables and per-variant breakdowns, and LaTeX booktabs tables to paste into the
 * dissertation.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Metrics } from '@mcpvul/common/analysis/metrics';
import type { EvalResult, CaseRow } from './evalHarness';

const pct = (x: number) => (x * 100).toFixed(1);
const f3 = (x: number) => x.toFixed(3);

/** Write all artifacts to `outDir`; returns the file paths written. */
export function writeEval(outDir: string, r: EvalResult): string[] {
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const w = (name: string, content: string) => {
    const p = join(outDir, name);
    writeFileSync(p, content);
    files.push(p);
  };

  w('metrics.json', JSON.stringify(r, null, 2));
  w('metrics.csv', metricsCsv(r));
  w('rows.csv', rowsCsv(r.rows));
  w('report.md', reportMarkdown(r));
  w('tables.tex', latexTables(r));
  return files;
}

const METRIC_COLS = ['n', 'tp', 'fp', 'fn', 'tn', 'precision', 'recall', 'f1', 'accuracy', 'specificity', 'fpr', 'mcc'];

function metricRow(scope: string, m: Metrics): string {
  return [
    scope,
    m.total,
    m.tp,
    m.fp,
    m.fn,
    m.tn,
    f3(m.precision),
    f3(m.recall),
    f3(m.f1),
    f3(m.accuracy),
    f3(m.specificity),
    f3(m.fpr),
    f3(m.mcc),
  ].join(',');
}

function metricsCsv(r: EvalResult): string {
  const lines = [`scope,${METRIC_COLS.join(',')}`];
  lines.push(metricRow('overall', r.overall));
  for (const [k, m] of Object.entries(r.byFlowVariant)) lines.push(metricRow(`flow:${k}`, m));
  for (const [k, m] of Object.entries(r.byFunctionalVariant)) lines.push(metricRow(`func:${k}`, m));
  for (const [k, m] of Object.entries(r.byCwe)) lines.push(metricRow(`cwe:${k}`, m));
  return lines.join('\n') + '\n';
}

function rowsCsv(rows: CaseRow[]): string {
  const cols = ['id', 'status', 'cwe', 'flowVariant', 'functionalVariant', 'tp', 'fp', 'fn', 'tn', 'candidates', 'flagged', 'durationMs', 'tokens', 'scanId', 'error'];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc((r as any)[c])).join(','));
  return lines.join('\n') + '\n';
}

function mdMetricTable(title: string, entries: Array<[string, Metrics]>): string {
  const head = `### ${title}\n\n| scope | n | TP | FP | FN | TN | Precision | Recall | F1 | Acc | Spec | MCC |\n|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|`;
  const rows = entries.map(
    ([k, m]) => `| ${k} | ${m.total} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} | ${f3(m.precision)} | ${f3(m.recall)} | ${f3(m.f1)} | ${f3(m.accuracy)} | ${f3(m.specificity)} | ${f3(m.mcc)} |`,
  );
  return [head, ...rows].join('\n');
}

function provenanceLines(r: EvalResult): string[] {
  const p = r.provenance;
  const tools = Object.entries(p.toolVersions ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ');
  return [
    '## Reproducibility',
    '',
    '| field | value |',
    '|---|---|',
    `| Model | ${p.model ?? '— (no_llm)'} |`,
    `| Provider | ${p.provider ?? '—'} |`,
    `| Temperature | ${p.temperature ?? '—'} |`,
    `| Runs | ${p.runs ?? 1} |`,
    `| Git commit | ${p.gitCommit ?? '—'} |`,
    `| Tool versions | ${tools || '—'} |`,
    `| Corpus hash | ${p.corpusHash ?? '—'} |`,
    '',
  ];
}

function reportMarkdown(r: EvalResult): string {
  const m = r.overall;
  const lines: string[] = [
    `# Evaluation report — ${r.mode}${r.dynamic !== 'off' ? ` +dynamic(${r.dynamic})` : ''}`,
    '',
    `- Corpus: \`${r.corpus}\``,
    `- Generated: ${r.generatedAt}`,
    `- Cases: ${r.ranOk}/${r.caseCount} ran ok`,
    `- Cost: mean ${r.cost.meanDurationMs} ms/case · ${r.cost.totalTokens} tokens total (${r.cost.meanTokens}/case)`,
    `- Expected Calibration Error: ${f3(r.ece)}`,
    '',
    ...provenanceLines(r),
    '## Overall',
    '',
    '| metric | value |',
    '|---|--:|',
    `| Precision | ${f3(m.precision)} (${pct(m.precision)}%) |`,
    `| Recall | ${f3(m.recall)} (${pct(m.recall)}%) |`,
    `| F1 | ${f3(m.f1)} |`,
    `| Accuracy | ${f3(m.accuracy)} |`,
    `| Specificity (TNR) | ${f3(m.specificity)} |`,
    `| FPR | ${f3(m.fpr)} |`,
    `| MCC | ${f3(m.mcc)} |`,
    '',
    '### Confusion matrix',
    '',
    '| | predicted leak | predicted clean |',
    '|---|--:|--:|',
    `| **actual leak** | TP = ${m.tp} | FN = ${m.fn} |`,
    `| **actual clean** | FP = ${m.fp} | TN = ${m.tn} |`,
    '',
    '## Breakdowns',
    '',
    mdMetricTable('By flow variant', Object.entries(r.byFlowVariant)),
    '',
    mdMetricTable('By functional variant', Object.entries(r.byFunctionalVariant)),
    '',
    '## Confidence calibration',
    '',
    '| bin | n | mean confidence | empirical accuracy |',
    '|---|--:|--:|--:|',
    ...r.calibration
      .filter((b) => b.count > 0)
      .map((b) => `| [${b.lo.toFixed(1)}, ${b.hi.toFixed(1)}) | ${b.count} | ${f3(b.meanConfidence)} | ${f3(b.empiricalAccuracy)} |`),
  ];
  return lines.join('\n') + '\n';
}

const texEsc = (s: string) => s.replace(/[_&%#$]/g, (c) => `\\${c}`);

function latexTables(r: EvalResult): string {
  const m = r.overall;
  const overall = [
    '% Overall metrics',
    '\\begin{table}[h]\\centering',
    `\\caption{Detection metrics (${texEsc(r.mode)}${r.dynamic !== 'off' ? ` + dynamic` : ''}) on ${texEsc(r.corpus.split('/').pop() ?? '')}}`,
    '\\begin{tabular}{lr}',
    '\\toprule',
    'Metric & Value \\\\',
    '\\midrule',
    `Precision & ${f3(m.precision)} \\\\`,
    `Recall & ${f3(m.recall)} \\\\`,
    `F1 & ${f3(m.f1)} \\\\`,
    `Accuracy & ${f3(m.accuracy)} \\\\`,
    `Specificity & ${f3(m.specificity)} \\\\`,
    `MCC & ${f3(m.mcc)} \\\\`,
    '\\midrule',
    `TP/FP/FN/TN & ${m.tp}/${m.fp}/${m.fn}/${m.tn} \\\\`,
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}',
  ];
  const flowRows = Object.entries(r.byFlowVariant).map(
    ([k, mm]) => `${k} & ${mm.total} & ${f3(mm.precision)} & ${f3(mm.recall)} & ${f3(mm.f1)} \\\\`,
  );
  const byFlow = [
    '',
    '% By flow variant',
    '\\begin{table}[h]\\centering',
    '\\caption{Metrics by flow variant}',
    '\\begin{tabular}{lrrrr}',
    '\\toprule',
    'Flow & n & Precision & Recall & F1 \\\\',
    '\\midrule',
    ...flowRows,
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}',
  ];
  return [...overall, ...byFlow].join('\n') + '\n';
}
