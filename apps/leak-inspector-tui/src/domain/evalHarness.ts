/**
 * Benchmark evaluation harness. Runs the headless scanner over every labeled
 * case in a v2 corpus, scores each scan's findings against the case's ground
 * truth (evalScoring), and aggregates a confusion matrix into the scientific
 * metrics the thesis reports (Precision/Recall/F1 overall and per flow- /
 * functional-variant), plus confidence calibration and per-mode cost.
 *
 * Built for the full Juliet CWE-401 run: a concurrency pool, a per-case result
 * cache so `--resume` skips completed cases, and partial metrics at any time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accumulate,
  computeMetrics,
  calibrationBins,
  expectedCalibrationError,
  type ConfusionMatrix,
  type Metrics,
  type CalibrationBin,
  type Sample,
} from '@mcpvul/common/analysis/metrics';
import { mapWithLimit } from '@mcpvul/agent-core';
import { runHeadless } from '../surfaces/headless';
import { scoreCase, isFlagged, type LabeledCase, type LabeledManifest, type SnapshotFinding } from './evalScoring';

export interface EvalOptions {
  corpusDir: string;
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  outDir: string;
  limit?: number;
  concurrency?: number;
  resume?: boolean;
  staticUrl?: string;
  dynamicUrl?: string;
  onProgress?: (done: number, total: number, id: string) => void;
}

export interface CaseRow {
  id: string;
  cwe?: string;
  flowVariant?: string;
  functionalVariant?: string;
  status: 'ok' | 'error';
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  candidates: number;
  flagged: number;
  durationMs: number;
  tokens: number;
  scanId?: string;
  error?: string;
}

export interface EvalResult {
  corpus: string;
  mode: string;
  dynamic: string;
  generatedAt: string;
  caseCount: number;
  ranOk: number;
  overall: Metrics;
  byFlowVariant: Record<string, Metrics>;
  byFunctionalVariant: Record<string, Metrics>;
  byCwe: Record<string, Metrics>;
  calibration: CalibrationBin[];
  ece: number;
  cost: { cases: number; meanDurationMs: number; totalTokens: number; meanTokens: number };
  rows: CaseRow[];
}

interface CachedCase {
  id: string;
  samples: Sample[];
  row: CaseRow;
}

function metricsByKey(groups: Map<string, Sample[]>): Record<string, Metrics> {
  const out: Record<string, Metrics> = {};
  for (const [key, samples] of [...groups.entries()].sort()) out[key] = computeMetrics(accumulate(samples));
  return out;
}

export async function runEval(opts: EvalOptions): Promise<EvalResult> {
  const manifestPath = join(opts.corpusDir, 'corpus_manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as LabeledManifest;
  const cases = (manifest.cases ?? []).slice(0, opts.limit ?? Infinity);
  const caseCacheDir = join(opts.outDir, 'cases');
  mkdirSync(caseCacheDir, { recursive: true });

  const concurrency = opts.concurrency ?? (opts.mode === 'no_llm' ? 6 : 3);
  let done = 0;

  const scoreOne = async (c: LabeledCase): Promise<CachedCase> => {
    const cachePath = join(caseCacheDir, `${c.id}.json`);
    if (opts.resume && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as CachedCase;
        opts.onProgress?.(++done, cases.length, `${c.id} (cached)`);
        return cached;
      } catch {
        /* fall through to re-run */
      }
    }
    const repo = join(opts.corpusDir, c.repo_path);
    const started = Date.now();
    try {
      const r = await runHeadless({
        repo,
        mode: opts.mode,
        dynamic: opts.dynamic,
        format: 'snapshot',
        build: c.build_command,
        staticUrl: opts.staticUrl,
        dynamicUrl: opts.dynamicUrl,
        quiet: true,
      });
      const durationMs = Date.now() - started;
      const snapshot = JSON.parse(readFileSync(join(r.dir, 'snapshot.json'), 'utf-8')) as { findings?: SnapshotFinding[] };
      const findings = snapshot.findings ?? [];
      const samples = scoreCase(findings, c);
      const cm = accumulate(samples);
      const tokens = (r.investigation?.usage?.inputTokens ?? 0) + (r.investigation?.usage?.outputTokens ?? 0);
      const row: CaseRow = {
        id: c.id,
        cwe: c.cwe,
        flowVariant: c.flowVariant,
        functionalVariant: c.functionalVariant,
        status: 'ok',
        tp: cm.tp,
        fp: cm.fp,
        fn: cm.fn,
        tn: cm.tn,
        candidates: findings.length,
        flagged: findings.filter((f) => isFlagged(f.verdict)).length,
        durationMs,
        tokens,
        scanId: r.scanId,
      };
      const result: CachedCase = { id: c.id, samples, row };
      writeFileSync(cachePath, JSON.stringify(result));
      opts.onProgress?.(++done, cases.length, c.id);
      return result;
    } catch (err: any) {
      const row: CaseRow = {
        id: c.id,
        cwe: c.cwe,
        flowVariant: c.flowVariant,
        functionalVariant: c.functionalVariant,
        status: 'error',
        tp: 0,
        fp: 0,
        fn: 0,
        tn: 0,
        candidates: 0,
        flagged: 0,
        durationMs: Date.now() - started,
        tokens: 0,
        error: err?.message ?? String(err),
      };
      opts.onProgress?.(++done, cases.length, `${c.id} (error)`);
      return { id: c.id, samples: [], row };
    }
  };

  const cached = await mapWithLimit(cases, concurrency, scoreOne);

  // ── Aggregate ──
  const allSamples: Sample[] = [];
  const byFlow = new Map<string, Sample[]>();
  const byFunc = new Map<string, Sample[]>();
  const byCwe = new Map<string, Sample[]>();
  const push = (m: Map<string, Sample[]>, k: string | undefined, s: Sample[]) => {
    const key = k || 'unknown';
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(...s);
  };
  for (let i = 0; i < cached.length; i++) {
    const { samples } = cached[i];
    const c = cases[i];
    allSamples.push(...samples);
    push(byFlow, c.flowVariant, samples);
    push(byFunc, c.functionalVariant, samples);
    push(byCwe, c.cwe, samples);
  }

  const rows = cached.map((c) => c.row);
  const okRows = rows.filter((r) => r.status === 'ok');
  const totalTokens = okRows.reduce((a, r) => a + r.tokens, 0);
  const totalDuration = okRows.reduce((a, r) => a + r.durationMs, 0);

  return {
    corpus: opts.corpusDir,
    mode: opts.mode,
    dynamic: opts.dynamic,
    generatedAt: new Date().toISOString(),
    caseCount: cases.length,
    ranOk: okRows.length,
    overall: computeMetrics(accumulate(allSamples)),
    byFlowVariant: metricsByKey(byFlow),
    byFunctionalVariant: metricsByKey(byFunc),
    byCwe: metricsByKey(byCwe),
    calibration: calibrationBins(allSamples, 10),
    ece: expectedCalibrationError(allSamples, 10),
    cost: {
      cases: okRows.length,
      meanDurationMs: okRows.length ? Math.round(totalDuration / okRows.length) : 0,
      totalTokens,
      meanTokens: okRows.length ? Math.round(totalTokens / okRows.length) : 0,
    },
    rows,
  };
}
