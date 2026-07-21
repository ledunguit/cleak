/**
 * Tests for runBaselineEval() — the harness that runs a baseline adapter over a
 * labeled corpus and scores its findings with the same metrics pipeline the
 * system eval uses. Uses a mock adapter so no real analyzer is ever invoked.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runBaselineEval } from '../../../src/domain/baselines/runBaselineEval';
import { countSourceLoc } from '@cleak/common/analysis/harness-utils';
import type { BaselineAdapter } from '../../../src/domain/baselines/adapter';
import type { LabeledCase, SnapshotFinding } from '../../../src/domain/evalScoring';
import type { Sample } from '@cleak/common/analysis/metrics';
import type { BaselineCaseRow } from '../../../src/domain/baselines/runBaselineEval';

// ── Path helpers ──────────────────────────────────────────────────────────
// The test file lives at apps/leak-inspector-tui/tests/domain/baselines/
// Going up 5 levels reaches the monorepo root.
const repoRoot = resolve(import.meta.dirname, '../../../../..');
const julietDir = join(repoRoot, 'demo/juliet_cwe401');

// ── Mock adapters ─────────────────────────────────────────────────────────

/** Create a mock adapter that returns the given findings unchanged. */
function mockAdapter(findings: SnapshotFinding[]): BaselineAdapter {
  return {
    name: 'mock-test',
    available: async () => true,
    run: async (_dir: string, _c: LabeledCase) => findings,
  };
}

/** Adapter that always throws — for the error-path test. */
const errorAdapter: BaselineAdapter = {
  name: 'mock-error',
  available: async () => true,
  run: async () => {
    throw new Error('simulated failure');
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('runBaselineEval', () => {
  test('returns BaselineResult with expected structure', async () => {
    // Return a finding that matches the FIRST Juliet case's flaw (function-mode
    // match: the finding's function name equals the labeled flaw's function).
    const result = await runBaselineEval(
      mockAdapter([
        {
          function: 'CWE401_Memory_Leak__char_calloc_01_bad',
          verdict: 'confirmed_leak',
        },
      ]),
      julietDir,
      { limit: 1, concurrency: 1 },
    );

    expect(result.name).toBe('mock-test');
    expect(result.caseCount).toBe(1);
    expect(result.ranOk).toBe(1);

    // Confusion-matrix fields are always present (even if all zero).
    expect(result.overall).toBeDefined();
    expect(result.overall.tp).toBeGreaterThanOrEqual(0);
    expect(result.overall.fp).toBeGreaterThanOrEqual(0);
    expect(result.overall.fn).toBeGreaterThanOrEqual(0);
    expect(result.overall.tn).toBeGreaterThanOrEqual(0);
    expect(typeof result.overall.precision).toBe('number');
    expect(typeof result.overall.recall).toBe('number');
    expect(typeof result.overall.f1).toBe('number');

    // Collections.
    expect(Array.isArray(result.samples)).toBe(true);
    expect(Array.isArray(result.rows)).toBe(true);

    // Variant breakdowns and calibration (Todo 2.2 fields).
    expect(result.byFlowVariant).toBeDefined();
    expect(result.byFunctionalVariant).toBeDefined();
    expect(result.byCwe).toBeDefined();
    expect(Array.isArray(result.calibration)).toBe(true);
  });

  test('adapter error → row.status === error', async () => {
    const result = await runBaselineEval(errorAdapter, julietDir, {
      limit: 1,
      concurrency: 1,
    });

    expect(result.ranOk).toBe(0);
    expect(result.rows[0].status).toBe('error');
    expect(result.rows[0].error).toContain('simulated failure');
  });

  test('stratify produces round-robin case order (does not crash)', async () => {
    const adapter = mockAdapter([]);
    const result = await runBaselineEval(adapter, julietDir, {
      limit: 3,
      concurrency: 1,
      stratify: 'functionalVariant',
    });

    // With limit=3 and ~10 functional variants, all 3 cases should run OK
    // even though mockAdapter returns empty findings (scored as FN).
    expect(result.ranOk).toBeGreaterThan(0);
  });

  test('resume mode: cache hit skips adapter.run', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'baseline-cachehit-'));
    const casesDir = join(tmpDir, 'cases');
    mkdirSync(casesDir, { recursive: true });

    // Seed a cache entry for the first Juliet case.
    const cachedSamples: Sample[] = [
      { actual: true, predicted: true, confidence: 1, siteId: 'test::site' },
    ];
    const cachedRow: BaselineCaseRow = {
      id: 'CWE401_Memory_Leak__char_calloc_01',
      status: 'ok',
      tp: 1,
      fp: 0,
      fn: 0,
      tn: 0,
      flagged: 1,
      loc: 0,
    };
    writeFileSync(
      join(casesDir, 'CWE401_Memory_Leak__char_calloc_01.json'),
      JSON.stringify({ samples: cachedSamples, row: cachedRow }),
    );

    let adapterCalled = false;
    const adapter: BaselineAdapter = {
      name: 'mock-cache-hit',
      available: async () => true,
      run: async () => {
        adapterCalled = true;
        return [];
      },
    };

    const result = await runBaselineEval(adapter, julietDir, {
      limit: 1,
      concurrency: 1,
      resume: true,
      outDir: tmpDir,
    });

    expect(adapterCalled).toBe(false);
    expect(result.rows[0].tp).toBe(1);
    expect(result.rows[0].status).toBe('ok');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resume mode: cache miss falls through to adapter.run', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'baseline-cachemiss-'));

    let adapterCalled = false;
    const adapter: BaselineAdapter = {
      name: 'mock-cache-miss',
      available: async () => true,
      run: async () => {
        adapterCalled = true;
        return [];
      },
    };

    const result = await runBaselineEval(adapter, julietDir, {
      limit: 1,
      concurrency: 1,
      resume: true,
      outDir: tmpDir,
    });

    // No cache file existed → adapter.run must have been invoked.
    expect(adapterCalled).toBe(true);
    expect(result.rows[0].status).toBe('ok');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('countSourceLoc', () => {
  test('returns 0 for non-existent directory', () => {
    expect(countSourceLoc('/nonexistent/path')).toBe(0);
  });

  test('returns positive count for valid C source directory', () => {
    const loc = countSourceLoc(
      join(repoRoot, 'demo/memory_leak_corpus/simple_leak'),
    );
    // simple_leak has main.c with ~30 non-blank lines.
    expect(loc).toBeGreaterThan(0);
  });
});
