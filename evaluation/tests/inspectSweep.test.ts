import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { aggregateCaseCache, inspectBaselineDir } from '../inspectSweep';

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'cleak-inspect-'));
}

function writeCase(cacheDir: string, id: string, row: Partial<Record<string, unknown>>): void {
  mkdirSync(cacheDir, { recursive: true });
  const full = {
    status: 'ok',
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    loc: 100,
    judgePathCounts: {},
    inputTokens: 0,
    outputTokens: 0,
    ...row,
  };
  writeFileSync(join(cacheDir, `${id}.json`), JSON.stringify({ id, samples: [], row: full, findings: [] }));
}

describe('aggregateCaseCache', () => {
  test('an empty/missing cache dir aggregates to zero, not a crash', () => {
    const agg = aggregateCaseCache(join(scratchDir(), 'nope'));
    expect(agg).toEqual({ done: 0, statusCounts: {}, judgePathCounts: {}, tp: 0, fp: 0, fn: 0, tn: 0, totalLoc: 0, fpPerKloc: 0, totalTokens: 0 });
  });

  test('sums confusion counts and judge paths across ok cases only', () => {
    const dir = join(scratchDir(), 'cases');
    writeCase(dir, 'case1', { status: 'ok', tp: 2, fp: 1, loc: 200, judgePathCounts: { llm: 3, heuristic: 1 } });
    writeCase(dir, 'case2', { status: 'ok', tp: 1, fp: 0, loc: 300, judgePathCounts: { heuristic: 2 } });
    writeCase(dir, 'case3', { status: 'error' }); // must not pollute tp/fp/loc
    const agg = aggregateCaseCache(dir);
    expect(agg.done).toBe(3);
    expect(agg.statusCounts).toEqual({ ok: 2, error: 1 });
    expect(agg.judgePathCounts).toEqual({ llm: 3, heuristic: 3 });
    expect(agg.tp).toBe(3);
    expect(agg.fp).toBe(1);
    expect(agg.totalLoc).toBe(500); // error case's loc excluded
    expect(agg.fpPerKloc).toBeCloseTo((1 / 500) * 1000, 6);
  });

  test('a torn-write (malformed JSON) is skipped, not fatal', () => {
    const dir = join(scratchDir(), 'cases');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'partial.json'), '{"id":"partial","row":{'); // truncated
    writeCase(dir, 'good', { status: 'ok', tp: 1 });
    const agg = aggregateCaseCache(dir);
    expect(agg.done).toBe(1);
    expect(agg.tp).toBe(1);
  });
});

describe('inspectBaselineDir', () => {
  test('single-run baseline with no output on disk yet reports no runs, no row', () => {
    const dir = join(scratchDir(), 'B1');
    const insp = inspectBaselineDir('B1', 'Static only', dir, 1);
    expect(insp.runs).toEqual([]);
    expect(insp.row).toBeUndefined();
  });

  test('single-run baseline mid-flight (cases/ populated, no metrics.json) is in_progress', () => {
    const dir = join(scratchDir(), 'B1');
    writeCase(join(dir, 'cases'), 'a', { status: 'ok', tp: 1, fp: 1, loc: 100 });
    const insp = inspectBaselineDir('B1', 'Static only', dir, 1);
    expect(insp.row).toBeUndefined();
    expect(insp.runs).toHaveLength(1);
    const run = insp.runs[0];
    expect(run.final).toBe(false);
    if (!run.final) expect(run.progress.done).toBe(1);
  });

  test('single-run baseline with metrics.json is final and yields a row', () => {
    const dir = join(scratchDir(), 'B1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'metrics.json'),
      JSON.stringify({
        caseCount: 10,
        ranOk: 10,
        overall: { tp: 5, fp: 1, fn: 2, tn: 2, precision: 0.833, recall: 0.714, f1: 0.77 },
        ece: 0.1,
        cost: { fpPerKloc: 0.5, meanDurationMs: 100, meanMcpCalls: 1, meanTokens: 0, totalTokens: 0 },
      }),
    );
    const insp = inspectBaselineDir('B1', 'Static only', dir, 1);
    expect(insp.row).toBeDefined();
    expect(insp.row!.status).toBe('ok');
    expect(insp.row!.f1).toBeCloseTo(0.77);
    expect(insp.runs).toEqual([{ run: 1, final: true, result: expect.any(Object) }]);
  });

  test('multi-run baseline with no variance.json yet reports each run-N live from its cache', () => {
    const dir = join(scratchDir(), 'B6b');
    writeCase(join(dir, 'run-1', 'cases'), 'a', { status: 'ok', tp: 1 });
    writeCase(join(dir, 'run-2', 'cases'), 'a', { status: 'ok', tp: 2 });
    const insp = inspectBaselineDir('B6b', '+ tool_selector only', dir, 3);
    expect(insp.row).toBeUndefined();
    expect(insp.runs.map((r) => r.run)).toEqual([1, 2]);
    expect(insp.runs.every((r) => !r.final)).toBe(true);
  });

  test('multi-run baseline with variance.json is final and yields a mean±std row', () => {
    const dir = join(scratchDir(), 'B6b');
    mkdirSync(dir, { recursive: true });
    const perRunResult = (f1: number) => ({
      caseCount: 10,
      ranOk: 10,
      overall: { tp: 5, fp: 1, fn: 2, tn: 2, precision: 0.8, recall: 0.7, f1 },
      ece: 0.1,
      cost: { fpPerKloc: 0.5, meanDurationMs: 100, meanMcpCalls: 1, meanTokens: 0, totalTokens: 100 },
    });
    writeFileSync(
      join(dir, 'variance.json'),
      JSON.stringify({
        runs: 2,
        perRun: [perRunResult(0.8), perRunResult(0.86)],
        aggregate: {
          precision: { mean: 0.8 },
          recall: { mean: 0.7 },
          f1: { mean: 0.83, std: 0.03 },
          ece: { mean: 0.1 },
        },
      }),
    );
    const insp = inspectBaselineDir('B6b', '+ tool_selector only', dir, 2);
    expect(insp.row).toBeDefined();
    expect(insp.row!.runs).toBe(2);
    expect(insp.row!.f1).toBeCloseTo(0.83);
    expect(insp.row!.f1Std).toBeCloseTo(0.03);
    expect(insp.row!.totalTokens).toBe(200);
    expect(insp.runs.every((r) => r.final)).toBe(true);
  });
});
