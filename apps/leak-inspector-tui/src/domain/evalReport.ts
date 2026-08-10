/**
 * Render an EvalResult into thesis-ready artifacts: machine-readable metrics
 * (JSON/CSV), a human-readable Markdown report with confusion matrix + P/R/F1
 * tables and per-variant breakdowns, and LaTeX booktabs tables to paste into the
 * dissertation.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Metrics } from '@cleak/common/analysis/metrics';
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

const METRIC_COLS = ['n', 'tp', 'fp', 'fn', 'tn', 'precision', 'recall', 'f1', 'accuracy', 'specificity', 'fpr', 'mcc', 'inputTokens', 'outputTokens', 'costUsd'];

// Token/cost are whole-run aggregates, not scoped per flow/functional-variant/CWE
// breakdown — `cost` is blank on every row but 'overall' rather than adding a
// separate file for 3 numbers.
function metricRow(scope: string, m: Metrics, cost?: EvalResult['cost']): string {
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
    cost?.totalInputTokens ?? '',
    cost?.totalOutputTokens ?? '',
    cost && cost.priced ? f3(cost.costUsd!) : '',
  ].join(',');
}

function metricsCsv(r: EvalResult): string {
  const lines = [`scope,${METRIC_COLS.join(',')}`];
  lines.push(metricRow('overall', r.overall, r.cost));
  for (const [k, m] of Object.entries(r.byFlowVariant)) lines.push(metricRow(`flow:${k}`, m));
  for (const [k, m] of Object.entries(r.byFunctionalVariant)) lines.push(metricRow(`func:${k}`, m));
  for (const [k, m] of Object.entries(r.byCwe)) lines.push(metricRow(`cwe:${k}`, m));
  return lines.join('\n') + '\n';
}

function rowsCsv(rows: CaseRow[]): string {
  const cols = ['id', 'status', 'cwe', 'flowVariant', 'functionalVariant', 'tp', 'fp', 'fn', 'tn', 'candidates', 'flagged', 'durationMs', 'inputTokens', 'outputTokens', 'scanId', 'error'];
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

function samplingLabel(s?: EvalResult['provenance']['sampling']): string {
  if (!s || s.mode === 'all') return 'all cases';
  if (s.mode === 'random') return `random, n=${s.limit}, seed=${s.randomSeed}`;
  if (s.mode === 'stratified') return `stratified by ${s.stratifyKey}, n=${s.limit}`;
  return `first ${s.limit} (manifest order)`;
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
    `| Sample | ${samplingLabel(p.sampling)} |`,
    `| Judge | ${p.consensus ? (p.consensus.n > 1 ? `consensus×${p.consensus.n} (${p.consensus.rule})` : 'single-LLM') : 'heuristic'} |`,
    '',
  ];
}

/** "0.850–0.930" — the 95% bootstrap interval bounds. */
const ciStr = (ci?: { lo: number; hi: number }) => (ci ? `${f3(ci.lo)}–${f3(ci.hi)}` : '—');

function judgePathLine(r: EvalResult): string {
  const dist = r.judgePathDistribution ?? {};
  const entries = Object.entries(dist);
  if (entries.length === 0) return '- Judge path: — (no flagged verdicts)';
  const total = entries.reduce((a, [, n]) => a + n, 0) || 1;
  const parts = entries.sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n} (${pct(n / total)}%)`);
  return `- Judge path (flagged verdicts): ${parts.join(' · ')}`;
}

function reportMarkdown(r: EvalResult): string {
  const m = r.overall;
  const ci = r.overallCI;
  const lines: string[] = [
    `# Evaluation report — ${r.mode}${r.dynamic !== 'off' ? ` +dynamic(${r.dynamic})` : ''}`,
    '',
    `- Corpus: \`${r.corpus}\``,
    `- Generated: ${r.generatedAt}`,
    `- Cases: ${r.ranOk}/${r.caseCount} ran ok`,
    `- Cost: mean ${r.cost.meanDurationMs} ms/case · ${r.cost.totalInputTokens} in / ${r.cost.totalOutputTokens} out tokens total ` +
      `(${r.cost.meanInputTokens} in / ${r.cost.meanOutputTokens} out per case) · ${r.cost.totalMcpCalls} MCP calls (${r.cost.meanMcpCalls}/case)` +
      (r.cost.priced ? ` · $${r.cost.costUsd!.toFixed(2)}` : ` · cost: unpriced (set \`pricing.${r.provenance.model ?? '<model>'}\` to see $)`),
    `- FP density: ${f3(r.cost.fpPerKloc)} FP / KLOC (${m.fp} FP over ${r.cost.totalLoc} non-blank LOC)`,
    judgePathLine(r),
    `- Expected Calibration Error: ${f3(r.ece)}`,
    '',
    ...provenanceLines(r),
    '## Overall',
    '',
    '| metric | value | 95% CI |',
    '|---|--:|--:|',
    `| Precision | ${f3(m.precision)} (${pct(m.precision)}%) | ${ciStr(ci?.precision)} |`,
    `| Recall | ${f3(m.recall)} (${pct(m.recall)}%) | ${ciStr(ci?.recall)} |`,
    `| F1 | ${f3(m.f1)} | ${ciStr(ci?.f1)} |`,
    `| Accuracy | ${f3(m.accuracy)} | — |`,
    `| Specificity (TNR) | ${f3(m.specificity)} | — |`,
    `| FPR | ${f3(m.fpr)} | — |`,
    `| MCC | ${f3(m.mcc)} | — |`,
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
  const funcEntries = Object.entries(r.byFunctionalVariant);
  const byFunc: string[] = [];
  if (funcEntries.length > 0) {
    const funcRows = funcEntries.map(
      ([k, mm]) => `${k} & ${mm.total} & ${f3(mm.precision)} & ${f3(mm.recall)} & ${f3(mm.f1)} \\\\`,
    );
    byFunc.push(
      '',
      '% By functional variant',
      '\\begin{table}[h]\\centering',
      '\\caption{Metrics by functional variant}',
      '\\begin{tabular}{lrrrr}',
      '\\toprule',
      'Functional variant & n & Precision & Recall & F1 \\\\',
      '\\midrule',
      ...funcRows,
      '\\bottomrule',
      '\\end{tabular}',
      '\\end{table}',
    );
  }

  const cweEntries = Object.entries(r.byCwe);
  const byCwe: string[] = [];
  if (cweEntries.length > 1) {
    const cweRows = cweEntries.map(
      ([k, mm]) => `${k} & ${mm.total} & ${f3(mm.precision)} & ${f3(mm.recall)} & ${f3(mm.f1)} \\\\`,
    );
    byCwe.push(
      '',
      '% By CWE',
      '\\begin{table}[h]\\centering',
      '\\caption{Metrics by CWE}',
      '\\begin{tabular}{lrrrr}',
      '\\toprule',
      'CWE & n & Precision & Recall & F1 \\\\',
      '\\midrule',
      ...cweRows,
      '\\bottomrule',
      '\\end{tabular}',
      '\\end{table}',
    );
  }

  const calBins = r.calibration.filter(b => b.count > 0);
  const calTable: string[] = [];
  if (calBins.length > 0) {
    const calRows = calBins.map(
      b => `${f3(b.lo)}–${f3(b.hi)} & ${b.count} & ${f3(b.meanConfidence)} & ${f3(b.empiricalAccuracy)} \\\\`,
    );
    calTable.push(
      '',
      '% Calibration',
      '\\begin{table}[h]\\centering',
      `\\caption{Confidence calibration (ECE = ${f3(r.ece)})}`,
      '\\begin{tabular}{lrrr}',
      '\\toprule',
      'Bin & n & Confidence & Accuracy \\\\',
      '\\midrule',
      ...calRows,
      '\\bottomrule',
      '\\end{tabular}',
      '\\end{table}',
    );
  }

  const costTable: string[] = [];
  if (r.cost.totalInputTokens > 0 || r.cost.totalOutputTokens > 0) {
    costTable.push(
      '',
      '% Cost',
      '\\begin{table}[h]\\centering',
      r.cost.priced ? '\\caption{Cost}' : `\\caption{Cost — unpriced, configure pricing.${texEsc(r.provenance.model ?? '<model>')}}`,
      '\\begin{tabular}{lr}',
      '\\toprule',
      'Metric & Value \\\\',
      '\\midrule',
      `Cases & ${r.cost.cases} \\\\`,
      `Mean duration (ms) & ${r.cost.meanDurationMs} \\\\`,
      `Input tokens (total / mean) & ${r.cost.totalInputTokens} / ${r.cost.meanInputTokens} \\\\`,
      `Output tokens (total / mean) & ${r.cost.totalOutputTokens} / ${r.cost.meanOutputTokens} \\\\`,
      `MCP calls (total / mean) & ${r.cost.totalMcpCalls} / ${r.cost.meanMcpCalls} \\\\`,
      ...(r.cost.priced ? [`USD & \\$${r.cost.costUsd!.toFixed(2)} \\\\`] : []),
      '\\bottomrule',
      '\\end{tabular}',
      '\\end{table}',
    );
  }

  return [...overall, ...byFlow, ...byFunc, ...byCwe, ...calTable, ...costTable].join('\n') + '\n';
}
