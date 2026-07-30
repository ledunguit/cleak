import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listEvalRuns, loadEvalRun, resolveHistoricalRun } from '../../src/domain/evalHistory';

let resultsDir: string;

function writeRun(
  name: string,
  opts: {
    generatedAtMs: number;
    caseCount?: number;
    precision?: number;
    recall?: number;
    f1?: number;
    sampling?: unknown;
    corpusValidated?: boolean;
    rows?: unknown[];
    cachedCaseFindings?: Record<string, unknown[]>;
  },
) {
  const dir = join(resultsDir, name);
  mkdirSync(dir, { recursive: true });
  const rows = opts.rows ?? [
    { id: 'c1', status: 'ok', tp: 1, fp: 0, fn: 0, tn: 0, candidates: 1, flagged: 1 },
    { id: 'c2', status: 'error', tp: 0, fp: 0, fn: 0, tn: 0, candidates: 0, flagged: 0, error: 'boom' },
  ];
  writeFileSync(
    join(dir, 'metrics.json'),
    JSON.stringify({
      corpus: '/demo/memory_leak_corpus',
      mode: 'llm_assisted',
      dynamic: 'off',
      generatedAtMs: opts.generatedAtMs,
      caseCount: opts.caseCount ?? rows.length,
      overall: { precision: opts.precision ?? 0.5, recall: opts.recall ?? 0.5, f1: opts.f1 ?? 0.5 },
      provenance: { sampling: opts.sampling, corpusValidated: opts.corpusValidated ?? true },
      rows,
    }),
  );
  if (opts.cachedCaseFindings) {
    const casesDir = join(dir, 'cases');
    mkdirSync(casesDir, { recursive: true });
    for (const [id, findings] of Object.entries(opts.cachedCaseFindings)) {
      writeFileSync(join(casesDir, `${id}.json`), JSON.stringify({ findings }));
    }
  }
  return dir;
}

beforeAll(() => {
  resultsDir = mkdtempSync(join(tmpdir(), 'evalhistory-'));
  writeRun('eval-older', { generatedAtMs: 1000, precision: 0.4, recall: 0.4, f1: 0.4 });
  writeRun('eval-newer', {
    generatedAtMs: 2000,
    precision: 0.9,
    recall: 0.8,
    f1: 0.85,
    sampling: { mode: 'random', randomSeed: 42 },
    cachedCaseFindings: { c1: [{ id: 'f1' }] },
  });
  mkdirSync(join(resultsDir, 'not-a-run'), { recursive: true });
  writeFileSync(join(resultsDir, 'not-a-run', 'README.md'), 'nothing here');
});

afterAll(() => {
  rmSync(resultsDir, { recursive: true, force: true });
});

describe('listEvalRuns', () => {
  test('lists only dirs with metrics.json, newest first', () => {
    const runs = listEvalRuns(resultsDir);
    expect(runs.map((r) => r.name)).toEqual(['eval-newer', 'eval-older']);
  });

  test('summarizes precision/recall/f1/caseCount from metrics.json', () => {
    const runs = listEvalRuns(resultsDir);
    const newer = runs.find((r) => r.name === 'eval-newer')!;
    expect(newer.precision).toBe(0.9);
    expect(newer.recall).toBe(0.8);
    expect(newer.f1).toBe(0.85);
    expect(newer.caseCount).toBe(2);
  });

  test('respects the limit param', () => {
    expect(listEvalRuns(resultsDir, 1)).toHaveLength(1);
  });

  test('returns [] for a nonexistent resultsDir', () => {
    expect(listEvalRuns(join(resultsDir, 'does-not-exist'))).toEqual([]);
  });
});

describe('resolveHistoricalRun', () => {
  test('resolves by basename under resultsDir', () => {
    expect(resolveHistoricalRun('eval-newer', resultsDir)).toBe(join(resultsDir, 'eval-newer'));
  });

  test('resolves a direct absolute path with a metrics.json', () => {
    const dir = join(resultsDir, 'eval-older');
    expect(resolveHistoricalRun(dir, resultsDir)).toBe(dir);
  });

  test('returns undefined for a token that is neither', () => {
    expect(resolveHistoricalRun('not-a-run', resultsDir)).toBeUndefined();
    expect(resolveHistoricalRun('/some/random/corpus/path', resultsDir)).toBeUndefined();
  });
});

describe('loadEvalRun', () => {
  test('returns a read-only (running: false) EvalUiState mirroring the artifacts', () => {
    const state = loadEvalRun(join(resultsDir, 'eval-newer'))!;
    expect(state).not.toBeNull();
    expect(state.running).toBe(false);
    expect(state.corpus).toBe('/demo/memory_leak_corpus');
    expect(state.total).toBe(2);
    expect(state.cases).toHaveLength(2);
    expect(state.sampling).toEqual({ mode: 'random', randomSeed: 42 });
  });

  test('attaches cached findings only for cases with a cases/<id>.json (status ok)', () => {
    const state = loadEvalRun(join(resultsDir, 'eval-newer'))!;
    const c1 = state.cases.find((c) => c.id === 'c1')!;
    const c2 = state.cases.find((c) => c.id === 'c2')!;
    expect(c1.findings).toEqual([{ id: 'f1' }]);
    expect(c2.findings).toBeUndefined();
    expect(c2.status).toBe('error');
    expect(c2.error).toBe('boom');
  });

  test('returns null for a dir with no metrics.json', () => {
    expect(loadEvalRun(join(resultsDir, 'not-a-run'))).toBeNull();
  });
});
