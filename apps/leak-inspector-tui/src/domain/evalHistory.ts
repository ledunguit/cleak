/**
 * Reopen a PAST eval run (read-only) — `/eval history` lists recent runs,
 * `/eval <name>` loads one directly by output-dir name/path. Reuses the exact
 * artifacts `evalReport.ts` already writes (`metrics.json` is the full
 * `EvalResult`) — no new persistence format, no re-running anything.
 *
 * Known gap: per-case `findings` are only cached to `{outDir}/cases/{id}.json`
 * for cases that finished `status: 'ok'` (`evalHarness.ts`'s cache-on-success
 * path) — a historical `error`/`skipped` case shows its status/error/scores but
 * not a findings-vs-ground-truth Detail breakdown (that was never persisted).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalResult, CaseRow } from './evalHarness';
import type { EvalUiState, EvalCaseUi } from '../stores/types';
import type { SnapshotFinding } from './evalScoring';

export interface EvalRunSummary {
  dir: string;
  name: string;
  corpus: string;
  mode: string;
  dynamic: string;
  finishedAt: number;
  caseCount: number;
  precision: number;
  recall: number;
  f1: number;
}

function readResult(dir: string): EvalResult | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf-8')) as EvalResult;
  } catch {
    return null;
  }
}

/** List past eval runs under `resultsDir`, newest first. Cheap — only parses
 * `metrics.json`'s top-level fields, not per-case detail. */
export function listEvalRuns(resultsDir: string, limit = 15): EvalRunSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(resultsDir);
  } catch {
    return [];
  }
  const runs: EvalRunSummary[] = [];
  for (const entry of entries) {
    const dir = join(resultsDir, entry);
    if (!existsSync(join(dir, 'metrics.json'))) continue;
    const r = readResult(dir);
    if (!r) continue;
    runs.push({
      dir,
      name: entry,
      corpus: r.corpus,
      mode: r.mode,
      dynamic: r.dynamic,
      finishedAt: r.generatedAtMs ?? statSync(dir).mtimeMs,
      caseCount: r.caseCount,
      precision: r.overall.precision,
      recall: r.overall.recall,
      f1: r.overall.f1,
    });
  }
  return runs.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, limit);
}

/** Resolve a user-typed token (`/eval <token>`) to a past run's output
 * directory — accepts the full path, or just the directory's basename, so
 * `/eval eval-lamed-llm_assisted-2026-07-30T07-00-54` works
 * without the operator having to type `results/` too. Returns undefined if it
 * doesn't look like a historical run (caller then tries "new eval on this
 * corpus path" instead — the two are unambiguous since one lives under
 * `results/`, the other under a corpus root with its own manifest). */
export function resolveHistoricalRun(token: string, resultsDir: string): string | undefined {
  const direct = existsSync(join(token, 'metrics.json')) ? token : undefined;
  if (direct) return direct;
  const byName = join(resultsDir, token);
  if (existsSync(join(byName, 'metrics.json'))) return byName;
  return undefined;
}

function caseRowToUi(row: CaseRow, findings?: SnapshotFinding[]): EvalCaseUi {
  return {
    id: row.id,
    cwe: row.cwe,
    flowVariant: row.flowVariant,
    functionalVariant: row.functionalVariant,
    status: row.status,
    durationMs: row.durationMs,
    tp: row.tp,
    fp: row.fp,
    fn: row.fn,
    tn: row.tn,
    candidates: row.candidates,
    flagged: row.flagged,
    scanId: row.scanId,
    error: row.error,
    findings,
  };
}

/** Load a past run into the SAME `EvalUiState` shape the live dashboard uses,
 * so `EvalScreen` renders it unchanged (`running: false` is what makes the
 * screen treat it as historical — no live ticking, no abort). */
export function loadEvalRun(dir: string): EvalUiState | null {
  const result = readResult(dir);
  if (!result) return null;
  const cases = result.rows.map((row) => {
    let findings: SnapshotFinding[] | undefined;
    try {
      const cached = JSON.parse(readFileSync(join(dir, 'cases', `${row.id}.json`), 'utf-8'));
      findings = cached.findings;
    } catch {
      /* not cached (error/skipped cases, or a run predating this cache shape) */
    }
    return caseRowToUi(row, findings);
  });
  return {
    corpus: result.corpus,
    mode: result.mode,
    dynamic: result.dynamic,
    total: result.caseCount,
    done: cases.length,
    concurrency: 1,
    startedAt: result.generatedAtMs,
    finishedAt: result.generatedAtMs,
    running: false,
    cases,
    tab: 'overview',
    cursor: 0,
    result,
    outDir: dir,
    sampling: result.provenance?.sampling,
    allowUnvalidated: result.provenance?.corpusValidated === false,
    historical: true,
  };
}
