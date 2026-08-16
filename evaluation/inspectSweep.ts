/**
 * Read-only inspector for a baseline-sweep (or single eval) output directory —
 * reconstructs the same headline numbers `baseline-sweep.md` reports straight from
 * whatever is on disk right now, with NO live run required (safe to run over SSH
 * against a sweep another process is still writing to).
 *
 * Two states per baseline:
 * - **final**: every run has been aggregated (single-run: `<dir>/metrics.json`;
 *   multi-run: `<dir>/variance.json` — `runEvalRepeated` only returns, and
 *   `runBaselineSweep` only writes per-run `metrics.json`/`variance.json`, once
 *   ALL repeat runs finish, so a multi-run baseline has NO per-run `metrics.json`
 *   at all until the whole group is done). Rendered via the exact same
 *   `renderSweepMarkdown`/`Csv`/`Latex` the real sweep uses.
 * - **in progress**: only `cases/*.json` cache files exist for (some of) its
 *   runs. Aggregated live, straight from those per-case files — the same numbers
 *   `aggregateResults` would produce once the run finishes, computed early. This
 *   is what checking sweep health/progress by hand (ssh in, `node -e` over
 *   `cases/*.json`) was doing ad hoc throughout the 2026-08 WSL2 Juliet sweep.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseRow, EvalResult, RepeatedEvalResult } from '../apps/leak-inspector-tui/src/domain/evalHarness';
import type { BaselineSweepRow } from '../apps/leak-inspector-tui/src/domain/baselineSweep';

export interface RunProgress {
  /** Number of `cases/*.json` cache files found (any status, not just `ok`). */
  done: number;
  /** Count per `CaseRow.status` (`ok`/`error`/`skipped`/`budget_exceeded`/`circuit_broken`). */
  statusCounts: Record<string, number>;
  /** Summed per-case judge-path tally (`llm`/`heuristic`/`consensus`) — the
   * silent-fallback integrity signal (see `judgePathDistribution` doc in evalHarness.ts). */
  judgePathCounts: Record<string, number>;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  totalLoc: number;
  fpPerKloc: number;
  totalTokens: number;
}

const EMPTY_PROGRESS: RunProgress = {
  done: 0,
  statusCounts: {},
  judgePathCounts: {},
  tp: 0,
  fp: 0,
  fn: 0,
  tn: 0,
  totalLoc: 0,
  fpPerKloc: 0,
  totalTokens: 0,
};

/** Sum every `cases/*.json` cache file in `cacheDir` into a live partial
 * aggregate — same fp/KLOC formula as `aggregateResults` (`fp/totalLoc*1000`
 * over `ok` rows only). Tolerates a file mid-write (rare torn-write race during
 * a live run) by skipping it rather than crashing the whole report. */
export function aggregateCaseCache(cacheDir: string): RunProgress {
  if (!existsSync(cacheDir)) return { ...EMPTY_PROGRESS };
  const agg: RunProgress = { ...EMPTY_PROGRESS, statusCounts: {}, judgePathCounts: {} };
  for (const f of readdirSync(cacheDir)) {
    if (!f.endsWith('.json')) continue;
    let row: CaseRow;
    try {
      row = (JSON.parse(readFileSync(join(cacheDir, f), 'utf-8')) as { row: CaseRow }).row;
    } catch {
      continue;
    }
    agg.done++;
    agg.statusCounts[row.status] = (agg.statusCounts[row.status] ?? 0) + 1;
    for (const [k, v] of Object.entries(row.judgePathCounts ?? {})) {
      agg.judgePathCounts[k] = (agg.judgePathCounts[k] ?? 0) + v;
    }
    if (row.status === 'ok') {
      agg.tp += row.tp;
      agg.fp += row.fp;
      agg.fn += row.fn;
      agg.tn += row.tn;
      agg.totalLoc += row.loc;
      agg.totalTokens += row.inputTokens + row.outputTokens;
    }
  }
  agg.fpPerKloc = agg.totalLoc > 0 ? (agg.fp / agg.totalLoc) * 1000 : 0;
  return agg;
}

export type RunState = { run: number; final: true; result: EvalResult } | { run: number; final: false; progress: RunProgress };

export interface BaselineInspection {
  id: string;
  name: string;
  totalRuns: number;
  runs: RunState[];
  /** Set once every run is `final` — identical to the row `baseline-sweep.md`
   * would print for this id (same mean±std math as `runBaselineSweep`). */
  row?: BaselineSweepRow;
}

/** `runBaselineSweep`'s single-run row-building — duplicated (not imported) since
 * that logic lives inline in `baselines.ts`, not as an exported helper. */
function singleToRow(id: string, name: string, r: EvalResult): BaselineSweepRow {
  return {
    id,
    name,
    status: 'ok',
    ranOk: r.ranOk,
    caseCount: r.caseCount,
    runs: 1,
    tp: r.overall.tp,
    fp: r.overall.fp,
    fn: r.overall.fn,
    tn: r.overall.tn,
    precision: r.overall.precision,
    recall: r.overall.recall,
    f1: r.overall.f1,
    fpPerKloc: r.cost.fpPerKloc,
    ece: r.ece,
    meanDurationMs: r.cost.meanDurationMs,
    meanMcpCalls: r.cost.meanMcpCalls,
    meanTokens: r.cost.meanTokens,
    totalTokens: r.cost.totalTokens,
    totalCostUsd: r.cost.priced ? r.cost.costUsd : undefined,
  };
}

/** `runBaselineSweep`'s multi-run row-building (mean/mean-round across runs, F1 std
 * from the aggregate) — duplicated for the same reason as `singleToRow`. */
function repeatedToRow(id: string, name: string, rep: RepeatedEvalResult): BaselineSweepRow {
  const mean = (sel: (r: EvalResult) => number) => rep.perRun.reduce((a, r) => a + sel(r), 0) / rep.perRun.length;
  const meanRound = (sel: (r: EvalResult) => number) => Math.round(mean(sel));
  return {
    id,
    name,
    status: 'ok',
    ranOk: meanRound((r) => r.ranOk),
    caseCount: rep.perRun[0]?.caseCount,
    runs: rep.runs,
    tp: meanRound((r) => r.overall.tp),
    fp: meanRound((r) => r.overall.fp),
    fn: meanRound((r) => r.overall.fn),
    tn: meanRound((r) => r.overall.tn),
    precision: rep.aggregate.precision.mean,
    recall: rep.aggregate.recall.mean,
    f1: rep.aggregate.f1.mean,
    f1Std: rep.aggregate.f1.std,
    fpPerKloc: mean((r) => r.cost.fpPerKloc),
    ece: rep.aggregate.ece.mean,
    meanDurationMs: mean((r) => r.cost.meanDurationMs),
    meanMcpCalls: mean((r) => r.cost.meanMcpCalls),
    meanTokens: mean((r) => r.cost.meanTokens),
    totalTokens: rep.perRun.reduce((a, r) => a + r.cost.totalTokens, 0),
    totalCostUsd: rep.perRun[0]?.cost.priced ? rep.perRun.reduce((a, r) => a + (r.cost.costUsd ?? 0), 0) : undefined,
  };
}

/** Inspect one baseline's output dir (`<sweepOutDir>/<id>`). `totalRuns` comes
 * from the resolved capability plan (`resolveCapabilities(...).runs`) — the
 * directory layout alone doesn't say how many runs were PLANNED, only how many
 * have left evidence on disk so far. */
export function inspectBaselineDir(id: string, name: string, dir: string, totalRuns: number): BaselineInspection {
  if (totalRuns <= 1) {
    const metricsPath = join(dir, 'metrics.json');
    if (existsSync(metricsPath)) {
      const r = JSON.parse(readFileSync(metricsPath, 'utf-8')) as EvalResult;
      return { id, name, totalRuns: 1, runs: [{ run: 1, final: true, result: r }], row: singleToRow(id, name, r) };
    }
    const progress = aggregateCaseCache(join(dir, 'cases'));
    return { id, name, totalRuns: 1, runs: progress.done > 0 ? [{ run: 1, final: false, progress }] : [] };
  }

  const variancePath = join(dir, 'variance.json');
  if (existsSync(variancePath)) {
    const rep = JSON.parse(readFileSync(variancePath, 'utf-8')) as RepeatedEvalResult;
    const runs: RunState[] = rep.perRun.map((r, i) => ({ run: i + 1, final: true, result: r }));
    return { id, name, totalRuns, runs, row: repeatedToRow(id, name, rep) };
  }

  // Not aggregated yet — every run (even ones that finished caching all their
  // cases) is reported live from cases/*.json until variance.json lands.
  const runDirs = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => /^run-\d+$/.test(n) && statSync(join(dir, n)).isDirectory())
        .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    : [];
  const runs: RunState[] = runDirs.map((rd) => ({
    run: Number(rd.slice(4)),
    final: false,
    progress: aggregateCaseCache(join(dir, rd, 'cases')),
  }));
  return { id, name, totalRuns, runs };
}
