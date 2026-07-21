/**
 * Run a baseline adapter over a labeled corpus and score it with the SAME
 * `scoreCase` / metrics the system eval uses — so a baseline's Precision/Recall/F1
 * and FP-per-KLOC are directly comparable to ours (Table 3). The per-site `samples`
 * are returned (carrying `siteId`) so a baseline can be paired against the system
 * via McNemar's test.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  accumulate,
  computeMetrics,
  bootstrapCI,
  makeRng,
  type Metrics,
  type Sample,
  type ConfidenceInterval,
} from '@cleak/common/analysis/metrics';
import { mapWithLimit } from '@cleak/agent-core';
import { countSourceLoc } from '@cleak/common/analysis/harness-utils';
import { selectCases } from '../evalHarness';
import { scoreCase, isFlagged, type LabeledCase, type LabeledManifest, type SnapshotFinding } from '../evalScoring';
import type { BaselineAdapter } from './adapter';

export interface BaselineCaseRow {
  id: string;
  status: 'ok' | 'error';
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  flagged: number;
  loc: number;
  error?: string;
}

export interface BaselineResult {
  name: string;
  corpus: string;
  caseCount: number;
  ranOk: number;
  overall: Metrics;
  overallCI: { precision: ConfidenceInterval; recall: ConfidenceInterval; f1: ConfidenceInterval };
  totalLoc: number;
  fpPerKloc: number;
  /** Per-site samples (with siteId) — enables McNemar pairing against the system. */
  samples: Sample[];
  rows: BaselineCaseRow[];
}

export interface RunBaselineOptions {
  limit?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number, id: string) => void;
  /** Stratify the sample evenly across this case key (e.g. `functionalVariant`). */
  stratify?: string;
  /** Reuse cached per-case results from a previous run (requires outDir). */
  resume?: boolean;
  /** Output directory for per-case cache files (required for resume). */
  outDir?: string;
}

export async function runBaselineEval(
  adapter: BaselineAdapter,
  corpusDir: string,
  opts: RunBaselineOptions = {},
): Promise<BaselineResult> {
  const manifestPath = join(corpusDir, 'corpus_manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as LabeledManifest;
  const cases = selectCases(manifest.cases ?? [], opts.limit, opts.stratify);
  let done = 0;

  const scoreOne = async (c: LabeledCase): Promise<{ samples: Sample[]; row: BaselineCaseRow }> => {
    const dir = resolve(corpusDir, c.repo_path);
    // Cache hit (resume mode)
    if (opts.resume && opts.outDir) {
      const cachePath = join(opts.outDir, 'cases', `${c.id}.json`);
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as { samples: Sample[]; row: BaselineCaseRow };
        opts.onProgress?.(++done, cases.length, `${c.id} (cached)`);
        return cached;
      } catch { /* fall through to re-run */ }
    }
    const loc = existsSync(dir) ? countSourceLoc(dir) : 0;
    try {
      const findings: SnapshotFinding[] = await adapter.run(dir, c);
      const samples = scoreCase(findings, c);
      const cm = accumulate(samples);
      const row: BaselineCaseRow = {
        id: c.id,
        status: 'ok',
        tp: cm.tp,
        fp: cm.fp,
        fn: cm.fn,
        tn: cm.tn,
        flagged: findings.filter((f) => isFlagged(f.verdict)).length,
        loc,
      };
      // Write cache (for resume)
      if (opts.outDir) {
        const cacheDir = join(opts.outDir, 'cases');
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, `${c.id}.json`), JSON.stringify({ samples, row }));
      }
      opts.onProgress?.(++done, cases.length, c.id);
      return { samples, row };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onProgress?.(++done, cases.length, `${c.id} (error)`);
      return {
        samples: [],
        row: { id: c.id, status: 'error', tp: 0, fp: 0, fn: 0, tn: 0, flagged: 0, loc, error: msg },
      };
    }
  };

  const results = await mapWithLimit(cases, opts.concurrency ?? 4, scoreOne);
  const allSamples = results.flatMap((r) => r.samples);
  const rows = results.map((r) => r.row);
  const okRows = rows.filter((r) => r.status === 'ok');
  const cm = accumulate(allSamples);
  const totalLoc = okRows.reduce((a, r) => a + r.loc, 0);
  const ci = (sel: (m: Metrics) => number) =>
    bootstrapCI(allSamples, (c) => sel(computeMetrics(c)), { iters: 1000, rng: makeRng(0xc0ffee) });

  return {
    name: adapter.name,
    corpus: corpusDir,
    caseCount: cases.length,
    ranOk: okRows.length,
    overall: computeMetrics(cm),
    overallCI: { precision: ci((m) => m.precision), recall: ci((m) => m.recall), f1: ci((m) => m.f1) },
    totalLoc,
    fpPerKloc: totalLoc > 0 ? (cm.fp / totalLoc) * 1000 : 0,
    samples: allSamples,
    rows,
  };
}
