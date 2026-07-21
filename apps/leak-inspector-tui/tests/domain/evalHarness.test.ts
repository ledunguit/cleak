/**
 * evalHarness — tests for the benchmark evaluation harness.
 *
 * Covers selectCases (pure), countSourceLoc (filesystem),
 * runEval (mocked integration), and runEvalRepeated (mocked aggregation).
 * The two runEval* tests mock runHeadless to avoid real MCP analyzer calls.
 */

import { describe, expect, test, mock, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Module-level mocks (must resolve BEFORE static imports) ──────────
//
// These replace imported dependencies so runEval/runEvalRepeated never
// call a real MCP analyzer or check a real corpus lockfile.

const mockRunHeadless = mock(() => ({
  dir: '',
  scanId: 'mock-scan',
  investigation: { usage: { inputTokens: 0, outputTokens: 0 } },
  mcpCalls: 0,
}));

mock.module('../../src/surfaces/headless', () => ({
  runHeadless: mockRunHeadless,
}));

// ── Static imports ───────────────────────────────────────────────────

import { selectCases } from '../../src/domain/evalHarness';
import { countSourceLoc } from '@cleak/common/analysis/harness-utils';

// ── selectCases (migrated from selectCases.test.ts + expanded) ───────

// Mimic Juliet's skew: cases grouped by family in manifest order.
const corpus = [
  ...Array.from({ length: 8 }, (_, i) => ({ id: `char-${i}`, functionalVariant: 'char' })),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `int-${i}`, functionalVariant: 'int' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `new-${i}`, functionalVariant: 'new' })),
  { id: 'dtor-0', functionalVariant: 'destructor' },
];

describe('selectCases', () => {
  test('no limit → all cases, order unchanged', () => {
    expect(selectCases(corpus)).toEqual(corpus);
  });

  test('top-N (no stratify) reproduces the skew', () => {
    const sel = selectCases(corpus, 6);
    expect(sel.map((c) => c.functionalVariant)).toEqual([
      'char', 'char', 'char', 'char', 'char', 'char',
    ]);
  });

  test('stratified sample covers every family evenly (round-robin)', () => {
    const sel = selectCases(corpus, 8, 'functionalVariant');
    const fams = sel.map((c) => c.functionalVariant);
    // Round 0: one of each (4 families), round 1: families with ≥2.
    expect(sel).toHaveLength(8);
    expect(new Set(fams).size).toBe(4); // all 4 families represented
    expect(fams.slice(0, 4).sort()).toEqual(['char', 'destructor', 'int', 'new']);
  });

  test('stratified is deterministic (same input → same output)', () => {
    expect(selectCases(corpus, 7, 'functionalVariant')).toEqual(
      selectCases(corpus, 7, 'functionalVariant'),
    );
  });

  test('stratified exhausts small groups then keeps filling from larger ones', () => {
    const sel = selectCases(corpus, 12, 'functionalVariant');
    const counts = sel.reduce<Record<string, number>>(
      (a, c) => ((a[c.functionalVariant] = (a[c.functionalVariant] ?? 0) + 1), a),
      {},
    );
    // destructor has only 1; char/int/new keep getting picked.
    expect(counts.destructor).toBe(1);
    expect(counts.char).toBeGreaterThanOrEqual(3);
    expect(sel).toHaveLength(12);
  });

  test('limit ≥ corpus size → all cases', () => {
    expect(selectCases(corpus, 999, 'functionalVariant')).toEqual(corpus);
  });

  // ── New stratify tests ─────────────────────────────────────────────

  test('stratify empty cases list returns empty', () => {
    expect(selectCases([], 5, 'functionalVariant')).toEqual([]);
  });

  test('stratify with all cases same variant picks top-N', () => {
    const same = [
      { id: 'a', functionalVariant: 'char' },
      { id: 'b', functionalVariant: 'char' },
      { id: 'c', functionalVariant: 'char' },
    ];
    expect(selectCases(same, 2, 'functionalVariant')).toHaveLength(2);
    expect(selectCases(same, 2, 'functionalVariant')[0].id).toBe('a');
  });

  test('stratify overflow (more requested than exist) returns all cases', () => {
    const small = [
      { id: 'x', functionalVariant: 'char' },
      { id: 'y', functionalVariant: 'int' },
    ];
    const result = selectCases(small, 5, 'functionalVariant');
    expect(result).toHaveLength(2);
  });
});

// ── countSourceLoc (filesystem-based) ─────────────────────────────────

describe('countSourceLoc', () => {
  test('counts non-blank lines in .c/.cc/.cpp/.cxx files recursively, ignoring hidden dirs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'countsl-'));
    try {
      // Single-line .c file
      writeFileSync(join(tmp, 'a.c'), 'int x = 1;\n');
      // .cpp file with blank lines at start
      writeFileSync(join(tmp, 'b.cpp'), '\n\nint main() {}\n');
      // Non-source extension (ignored)
      writeFileSync(join(tmp, 'readme.md'), 'hello\nworld\n');
      // Subdirectory with .cc source
      mkdirSync(join(tmp, 'sub'));
      writeFileSync(join(tmp, 'sub', 'c.cc'), [
        '#include <stdio.h>',
        '',
        'int main() {',
        '  return 0;',
        '}',
      ].join('\n'));
      // Hidden directory (dot-prefixed, ignored)
      mkdirSync(join(tmp, '.hidden'));
      writeFileSync(join(tmp, '.hidden', 'd.c'), 'should be ignored;\n');

      const result = countSourceLoc(tmp);

      // a.c: 1 non-blank; b.cpp: 1 non-blank; c.cc: 4 non-blank (include, main {, return 0;, }).
      // .md ignored; .hidden/d.c ignored.
      expect(result).toBe(6);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns 0 for directory with no source files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'countsl-empty-'));
    try {
      writeFileSync(join(tmp, 'notes.txt'), 'some text\n');
      expect(countSourceLoc(tmp)).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns 0 for an empty directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'countsl-empty2-'));
    try {
      expect(countSourceLoc(tmp)).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Phase functions ───────────────────────────────────────────────────

describe('loadManifest', () => {
  test('throws descriptive error on missing manifest', async () => {
    const { loadManifest } = await import('../../src/domain/evalHarness');
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-'));
    try {
      expect(() => loadManifest(tmp)).toThrow(/corpus_manifest/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('parses valid manifest', async () => {
    const { loadManifest } = await import('../../src/domain/evalHarness');
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-'));
    try {
      writeFileSync(
        join(tmp, 'corpus_manifest.json'),
        JSON.stringify({
          meta: { name: 'test' },
          cases: [{ id: 'c1', repo_path: 'p', flaws: [], clean: [] }],
          allocators: [],
          deallocators: [],
        }),
      );
      const m = loadManifest(tmp);
      expect(m.cases).toHaveLength(1);
      expect(m.cases[0].id).toBe('c1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('prepareCaseCache', () => {
  test('creates case cache directory', async () => {
    const { prepareCaseCache } = await import('../../src/domain/evalHarness');
    const out = mkdtempSync(join(tmpdir(), 'cache-'));
    try {
      const { cacheDir, concurrency } = prepareCaseCache(out);
      expect(cacheDir).toBe(join(out, 'cases'));
      expect(existsSync(cacheDir)).toBe(true);
      // Default concurrency
      expect(typeof concurrency).toBe('number');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

// ── runEval (mocked integration) ──────────────────────────────────────

describe('runEval', () => {
  /** Returns a temp dir with a valid corpus_manifest.json and a matching
   * snapshot.json for the single case.  The caller is responsible for cleanup. */
  function setupCorpus(): string {
    const tmp = mkdtempSync(join(tmpdir(), 'runEval-'));
    writeFileSync(
      join(tmp, 'corpus_manifest.json'),
      JSON.stringify({
        meta: { name: 'test-corpus', version: '1' },
        cases: [
          {
            id: 'test-case-1',
            repo_path: '.',
            build_command: 'make',
            cwe: 'CWE-401',
            flaws: [{ function: 'leaky' }],
            clean: [{ function: 'safe' }],
          },
        ],
        allocators: [],
        deallocators: [],
      }),
    );
    // A .c source file so countSourceLoc doesn't return 0.
    writeFileSync(join(tmp, 'main.c'), 'int leaky() { return 0; }\nint safe() { return 1; }\n');
    return tmp;
  }

  /** Creates a scan output directory with snapshot.json and returns its path. */
  function setupScanOut(): string {
    const d = mkdtempSync(join(tmpdir(), 'scanOut-'));
    writeFileSync(
      join(d, 'snapshot.json'),
      JSON.stringify({
        findings: [
          {
            function: 'leaky',
            file: 'main.c',
            line: 10,
            verdict: 'confirmed_leak',
            confidence: 0.95,
          },
        ],
      }),
    );
    return d;
  }

  test('is exported as a function', async () => {
    const { runEval } = await import('../../src/domain/evalHarness');
    expect(typeof runEval).toBe('function');
  });

  test('throws on missing corpus_manifest.json', async () => {
    const { runEval } = await import('../../src/domain/evalHarness');
    const tmp = mkdtempSync(join(tmpdir(), 'runEval-missing-'));
    try {
      await expect(
        runEval({
          corpusDir: tmp,
          mode: 'no_llm',
          dynamic: 'off',
          outDir: join(tmp, 'out'),
        }),
      ).rejects.toThrow(/corpus_manifest/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('mocked orchestration returns EvalResult with 1 case', async () => {
    const tmp = setupCorpus();
    const scanOut = setupScanOut();
    // Point mock runHeadless to the pre-written snapshot dir.
    mockRunHeadless.mockImplementation(() => ({
      dir: scanOut,
      scanId: 'mock-scan-id',
      investigation: { usage: { inputTokens: 50, outputTokens: 20 } },
      mcpCalls: 3,
    }));

    const { runEval } = await import('../../src/domain/evalHarness');
    try {
      const result = await runEval({
        corpusDir: tmp,
        mode: 'no_llm',
        dynamic: 'off',
        outDir: join(tmp, 'out'),
        allowUnvalidated: true,
        limit: 1,
      });

      // Top-level structure
      expect(result.caseCount).toBe(1);
      expect(result.ranOk).toBe(1);
      expect(result.mode).toBe('no_llm');
      expect(result.dynamic).toBe('off');
      expect(result.generatedAt).toBeDefined();
      expect(result.generatedAtMs).toBeGreaterThan(0);

      // Provenance (captureRunProvenance was called)
      expect(result.provenance).toBeDefined();
      expect(result.provenance.corpusValidated).toBe(false); // no lockfile → allowUnvalidated passes but gate.ok=false

      // Overall metrics: the mock snapshot has 1 TP finding vs 1 flaw → cm = { tp:1, fn:0, fp:0, tn?:0 }
      expect(result.overall.precision).toBe(1);
      expect(result.overall.recall).toBe(1);
      expect(result.overall.f1).toBe(1);

      // Breakdown maps exist (may be empty for a 1-case run)
      expect(typeof result.byFlowVariant).toBe('object');
      expect(typeof result.byFunctionalVariant).toBe('object');
      expect(typeof result.byCwe).toBe('object');

      // Calibration & ECE
      expect(Array.isArray(result.calibration)).toBe(true);
      expect(typeof result.ece).toBe('number');

      // Confidence intervals (bootstrap with 1 case may yield undefined entries)
      expect(result.overallCI).toBeDefined();
      if (result.overallCI.precision.lower !== undefined) {
        expect(typeof result.overallCI.precision.lower).toBe('number');
      }

      // Cost
      expect(result.cost.cases).toBe(1);
      expect(result.cost.totalTokens).toBe(70); // 50 + 20
      expect(result.cost.totalMcpCalls).toBe(3);
      expect(result.cost.totalLoc).toBe(2); // 2 non-blank lines in main.c

      // Per-case rows
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('test-case-1');
      expect(result.rows[0].status).toBe('ok');
      expect(result.rows[0].tp).toBe(1);
      expect(result.rows[0].fp).toBe(0);
      expect(result.rows[0].fn).toBe(0);
      expect(result.rows[0].loc).toBe(2);
      expect(result.rows[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(result.rows[0].scanId).toBe('mock-scan-id');

      // Samples array
      expect(result.samples.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(scanOut, { recursive: true, force: true });
    }
  });
});

// ── runEvalRepeated (mocked aggregation) ───────────────────────────────

describe('runEvalRepeated', () => {
  /** Ensures headless still points to a valid snapshot dir. */
  const scanOut = mkdtempSync(join(tmpdir(), 'repeatedScanOut-'));

  beforeAll(() => {
    writeFileSync(
      join(scanOut, 'snapshot.json'),
      JSON.stringify({
        findings: [
          {
            function: 'leaky',
            file: 'main.c',
            line: 10,
            verdict: 'confirmed_leak',
            confidence: 0.95,
          },
        ],
      }),
    );
  });

  afterAll(() => {
    rmSync(scanOut, { recursive: true, force: true });
  });

  test('aggregates metrics across multiple runs', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'repeated-'));
    try {
      writeFileSync(
        join(tmp, 'corpus_manifest.json'),
        JSON.stringify({
          meta: { name: 'test-corpus', version: '1' },
          cases: [
            {
              id: 'tc-1',
              repo_path: '.',
              flaws: [{ function: 'leaky' }],
              clean: [{ function: 'safe' }],
            },
          ],
          allocators: [],
          deallocators: [],
        }),
      );
      writeFileSync(join(tmp, 'main.c'), 'int leaky() { return 0; }\nint safe() { return 1; }\n');

      mockRunHeadless.mockImplementation(() => ({
        dir: scanOut,
        scanId: 'mock-repeated',
        investigation: { usage: { inputTokens: 50, outputTokens: 20 } },
        mcpCalls: 3,
      }));

      const { runEvalRepeated } = await import('../../src/domain/evalHarness');
      const result = await runEvalRepeated(
        {
          corpusDir: tmp,
          mode: 'no_llm',
          dynamic: 'off',
          outDir: join(tmp, 'out'),
          allowUnvalidated: true,
          limit: 1,
        },
        2,
      );

      // Repeated result structure
      expect(result.runs).toBe(2);
      expect(result.mode).toBe('no_llm');
      expect(result.perRun).toHaveLength(2);

      // Each run is a valid EvalResult
      for (const run of result.perRun) {
        expect(run.caseCount).toBe(1);
        expect(run.ranOk).toBe(1);
        expect(run.overall.f1).toBe(1);
      }

      // Aggregate stats (mean/std/min/max)
      expect(typeof result.aggregate.precision.mean).toBe('number');
      expect(typeof result.aggregate.recall.mean).toBe('number');
      expect(typeof result.aggregate.f1.mean).toBe('number');
      expect(typeof result.aggregate.accuracy.mean).toBe('number');
      expect(typeof result.aggregate.mcc.mean).toBe('number');
      expect(result.aggregate.f1.mean).toBe(1);
      expect(result.aggregate.f1.std).toBe(0);
      expect(result.aggregate.f1.min).toBe(1);
      expect(result.aggregate.f1.max).toBe(1);

      // Provenance carried from first run
      expect(result.provenance).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});


