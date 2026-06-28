/**
 * Pure helpers for the baseline ablation sweep (scripts/run-baselines.ts): the
 * "is this capability vector behaviourally wired yet?" gate and the comparison-table
 * renderers (Markdown / CSV / LaTeX). Kept network-free so they can be unit-tested.
 */

import type { ResolvedRunPlan } from './capabilityResolver';

/**
 * Whether the current engine can run a resolved plan FAITHFULLY today. Two
 * capabilities are still landing in Step 4:
 *  - static=false (dynamic-only discovery)              → Step 4a
 *  - fusion + tool_selector=false (deterministic recipe) → Step 4b
 * Until then the sweep skips those configs rather than publish numbers that don't
 * match the intended semantics. This gate disappears once Step 4 is complete.
 */
export function isWiredNow(plan: ResolvedRunPlan): { wired: boolean; reason?: string } {
  if (!plan.staticDiscovery) {
    return { wired: false, reason: 'dynamic-only discovery not yet implemented (Step 4a)' };
  }
  if (plan.mode === 'llm_assisted' && !plan.toolSelect) {
    return { wired: false, reason: 'deterministic-recipe fusion (tool_selector off) not yet implemented (Step 4b)' };
  }
  return { wired: true };
}

export interface BaselineSweepRow {
  id: string;
  name: string;
  status: 'ok' | 'skipped' | 'error';
  skipReason?: string;
  error?: string;
  ranOk?: number;
  caseCount?: number;
  runs?: number;
  precision?: number;
  recall?: number;
  f1?: number;
  /** Std of F1 across runs (multi-run / fusion configs only). */
  f1Std?: number;
  fpPerKloc?: number;
  meanDurationMs?: number;
  meanMcpCalls?: number;
  meanTokens?: number;
}

export interface SweepMeta {
  corpus: string;
  limit?: number;
  generatedAt?: string;
  gitCommit?: string;
}

const pct = (x?: number) => (x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const f3 = (x?: number) => (x === undefined ? '—' : x.toFixed(3));
const n0 = (x?: number) => (x === undefined ? '—' : String(Math.round(x)));

/** F1 cell — `mean ± std` for multi-run configs, plain for single-run. */
function f1Cell(r: BaselineSweepRow): string {
  if (r.f1 === undefined) return '—';
  return r.f1Std !== undefined && (r.runs ?? 1) > 1 ? `${r.f1.toFixed(3)} ± ${r.f1Std.toFixed(3)}` : r.f1.toFixed(3);
}

export function renderSweepMarkdown(rows: BaselineSweepRow[], meta: SweepMeta): string {
  const head = [
    `# Baseline ablation sweep — \`${meta.corpus}\`${meta.limit ? ` (limit ${meta.limit})` : ''}`,
    '',
    ...(meta.generatedAt ? [`- Generated: ${meta.generatedAt}`] : []),
    ...(meta.gitCommit ? [`- Git commit: \`${meta.gitCommit}\``] : []),
    '',
    '| ID | Baseline | Cases | Precision | Recall | F1 | FP/KLOC | ms/case | MCP/case | tok/case |',
    '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|',
  ];
  const body = rows.map((r) => {
    if (r.status !== 'ok') {
      const why = r.status === 'skipped' ? `_skipped: ${r.skipReason}_` : `_error: ${r.error}_`;
      return `| ${r.id} | ${r.name} | ${why} | | | | | | | |`;
    }
    return `| ${r.id} | ${r.name} | ${r.ranOk ?? 0}/${r.caseCount ?? 0} | ${pct(r.precision)} | ${pct(r.recall)} | ${f1Cell(r)} | ${f3(r.fpPerKloc)} | ${n0(r.meanDurationMs)} | ${n0(r.meanMcpCalls)} | ${n0(r.meanTokens)} |`;
  });
  return [...head, ...body, ''].join('\n');
}

export function renderSweepCsv(rows: BaselineSweepRow[]): string {
  const header = 'id,name,status,ranOk,caseCount,runs,precision,recall,f1,f1Std,fpPerKloc,meanDurationMs,meanMcpCalls,meanTokens';
  const cell = (x: number | undefined) => (x === undefined ? '' : String(x));
  const lines = rows.map((r) =>
    [
      r.id,
      `"${r.name.replace(/"/g, '""')}"`,
      r.status,
      cell(r.ranOk),
      cell(r.caseCount),
      cell(r.runs),
      cell(r.precision),
      cell(r.recall),
      cell(r.f1),
      cell(r.f1Std),
      cell(r.fpPerKloc),
      cell(r.meanDurationMs),
      cell(r.meanMcpCalls),
      cell(r.meanTokens),
    ].join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}

export function renderSweepLatex(rows: BaselineSweepRow[], meta: SweepMeta): string {
  const esc = (s: string) => s.replace(/_/g, '\\_').replace(/&/g, '\\&');
  const ok = rows.filter((r) => r.status === 'ok');
  const body = ok.map(
    (r) =>
      `${r.id} & ${esc(r.name)} & ${pct(r.precision)} & ${pct(r.recall)} & ${f1Cell(r)} & ${f3(r.fpPerKloc)} & ${n0(r.meanMcpCalls)} & ${n0(r.meanTokens)} \\\\`,
  );
  return [
    '\\begin{table}[t]',
    '\\centering',
    `\\caption{Baseline ablation on ${esc(meta.corpus)}.}`,
    '\\begin{tabular}{llrrrrrr}',
    '\\toprule',
    'ID & Baseline & P & R & F1 & FP/KLOC & MCP/case & tok/case \\\\',
    '\\midrule',
    ...body,
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}',
    '',
  ].join('\n');
}
