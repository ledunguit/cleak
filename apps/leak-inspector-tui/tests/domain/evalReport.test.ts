/**
 * Tests for evalReport.ts — writeEval (exported) feeds into 5 render functions
 * (internal: metricsCsv, rowsCsv, reportMarkdown, latexTables). We test them
 * ALL through writeEval by writing to a temp dir and verifying file contents.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeEval } from '../../src/domain/evalReport';
import type { EvalResult, CaseRow } from '../../src/domain/evalHarness';

// ── Fixture factory ────────────────────────────────────────────────────

function makeRow(over: Partial<CaseRow> = {}): CaseRow {
  return {
    id: 'case1',
    cwe: 'CWE-401',
    flowVariant: 'direct',
    functionalVariant: 'malloc',
    status: 'ok',
    tp: 2,
    fp: 0,
    fn: 1,
    tn: 2,
    candidates: 3,
    flagged: 2,
    loc: 100,
    judgePathCounts: { heuristic: 1 },
    durationMs: 1000,
    tokens: 1000,
    mcpCalls: 10,
    ...over,
  };
}

function makeEvalResult(over: Partial<EvalResult> = {}): EvalResult {
  return {
    corpus: 'demo/test',
    mode: 'no_llm',
    dynamic: 'off',
    generatedAt: '2026-07-21T00:00:00.000Z',
    generatedAtMs: 1782000000000,
    provenance: {
      gitCommit: 'abc1234',
      toolVersions: { clang: '18.1.0' },
      runs: 1,
    },
    caseCount: 5,
    ranOk: 5,
    overall: { total: 10, tp: 4, fp: 1, fn: 1, tn: 4, precision: 0.8, recall: 0.8, f1: 0.8, accuracy: 0.8, specificity: 0.8, fpr: 0.2, mcc: 0.6 },
    byFlowVariant: {
      direct: { total: 5, tp: 2, fp: 0, fn: 1, tn: 2, precision: 1, recall: 0.667, f1: 0.8, accuracy: 0.8, specificity: 1, fpr: 0, mcc: 0.667 },
    },
    byFunctionalVariant: {
      malloc: { total: 10, tp: 4, fp: 1, fn: 1, tn: 4, precision: 0.8, recall: 0.8, f1: 0.8, accuracy: 0.8, specificity: 0.8, fpr: 0.2, mcc: 0.6 },
    },
    byCwe: {
      'CWE-401': { total: 10, tp: 4, fp: 1, fn: 1, tn: 4, precision: 0.8, recall: 0.8, f1: 0.8, accuracy: 0.8, specificity: 0.8, fpr: 0.2, mcc: 0.6 },
    },
    calibration: [
      { lo: 0, hi: 0.5, count: 2, meanConfidence: 0.3, empiricalAccuracy: 0.5 },
      { lo: 0.5, hi: 0.8, count: 3, meanConfidence: 0.65, empiricalAccuracy: 0.667 },
      { lo: 0.8, hi: 1, count: 5, meanConfidence: 0.92, empiricalAccuracy: 0.8 },
    ],
    ece: 0.123,
    overallCI: {
      precision: { point: 0.8, lo: 0.6, hi: 0.95 },
      recall: { point: 0.8, lo: 0.6, hi: 0.95 },
      f1: { point: 0.8, lo: 0.6, hi: 0.95 },
    },
    judgePathDistribution: { heuristic: 3, llm: 1 },
    cost: {
      cases: 5,
      meanDurationMs: 1200,
      totalTokens: 5000,
      meanTokens: 1000,
      totalMcpCalls: 50,
      meanMcpCalls: 10,
      totalLoc: 500,
      fpPerKloc: 2,
    },
    rows: [makeRow()],
    samples: [],
    ...over,
  };
}

// ── Helper: write to a temp dir and parse output ───────────────────────

function writeAndRead(r: EvalResult): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'eval-report-test-'));
  writeEval(dir, r);
  const files: Record<string, string> = {};
  for (const name of ['metrics.json', 'report.md', 'tables.tex', 'metrics.csv', 'rows.csv']) {
    files[name.replace('.', '_')] = readFileSync(join(dir, name), 'utf-8');
  }
  return files;
}

// ── writeEval ──────────────────────────────────────────────────────────

describe('writeEval', () => {
  test('returns array of 5 file paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-test-'));
    const files = writeEval(dir, makeEvalResult());
    expect(Array.isArray(files)).toBe(true);
    expect(files).toHaveLength(5);
  });

  test('all output files exist on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-test-'));
    const files = writeEval(dir, makeEvalResult());
    for (const f of files) {
      expect(() => readFileSync(f, 'utf-8')).not.toThrow();
    }
  });

  test('file paths end with expected names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-test-'));
    const files = writeEval(dir, makeEvalResult());
    const basenames = files.map((f) => f.split('/').pop() ?? f.split('\\').pop());
    expect(basenames.sort()).toEqual(['metrics.csv', 'metrics.json', 'report.md', 'rows.csv', 'tables.tex'].sort());
  });

  test('metrics.json contains expected top-level keys', () => {
    const { metrics_json } = writeAndRead(makeEvalResult());
    const parsed = JSON.parse(metrics_json);
    expect(parsed.corpus).toBe('demo/test');
    expect(parsed.mode).toBe('no_llm');
    expect(parsed.overall.tp).toBe(4);
    expect(parsed.overall.f1).toBe(0.8);
    expect(parsed.provenance.gitCommit).toBe('abc1234');
    expect(parsed.generatedAtMs).toBe(1782000000000);
  });

  test('metrics.json contains breakdowns', () => {
    const { metrics_json } = writeAndRead(makeEvalResult());
    const parsed = JSON.parse(metrics_json);
    expect(parsed.byFlowVariant).toHaveProperty('direct');
    expect(parsed.byFunctionalVariant).toHaveProperty('malloc');
    expect(parsed.byCwe).toHaveProperty('CWE-401');
    expect(parsed.calibration).toHaveLength(3);
    expect(parsed.ece).toBe(0.123);
  });
});

// ── reportMarkdown (tested through writeEval file content) ──────────────

describe('reportMarkdown', () => {
  test('contains header with mode and corpus', () => {
    const { report_md } = writeAndRead(makeEvalResult());
    expect(report_md).toContain('# Evaluation report — no_llm');
    expect(report_md).toContain('Corpus: `demo/test`');
  });

  test('contains provenance section', () => {
    const { report_md } = writeAndRead(makeEvalResult());
    expect(report_md).toContain('## Reproducibility');
    expect(report_md).toContain('| Git commit | abc1234 |');
    expect(report_md).toContain('clang: 18.1.0');
  });

  test('contains Overall section with confusion matrix', () => {
    const { report_md } = writeAndRead(makeEvalResult());
    expect(report_md).toContain('## Overall');
    expect(report_md).toContain('### Confusion matrix');
    expect(report_md).toContain('TP = 4');
    expect(report_md).toContain('FP = 1');
    expect(report_md).toContain('FN = 1');
    expect(report_md).toContain('TN = 4');
    expect(report_md).toContain('| Precision | 0.800 (80.0%) |');
  });

  test('contains Breakdowns section', () => {
    const { report_md } = writeAndRead(makeEvalResult());
    expect(report_md).toContain('## Breakdowns');
    expect(report_md).toContain('### By flow variant');
    expect(report_md).toContain('### By functional variant');
  });

  test('contains Confidence calibration section with ECE', () => {
    const { report_md } = writeAndRead(makeEvalResult());
    expect(report_md).toContain('## Confidence calibration');
    expect(report_md).toContain('Expected Calibration Error: 0.123');
  });

  test('contains calibration bin entries', () => {
    const { report_md } = writeAndRead(makeEvalResult());
    // All 3 bins have count>0 so all appear
    expect(report_md).toContain('[0.0, 0.5)');
    expect(report_md).toContain('[0.5, 0.8)');
    expect(report_md).toContain('[0.8, 1.0)');
    expect(report_md).toContain('0.300');
    expect(report_md).toContain('0.650');
    expect(report_md).toContain('0.920');
  });

  test('contains judge path line', () => {
    const { report_md } = writeAndRead(makeEvalResult());
    expect(report_md).toContain('Judge path');
    expect(report_md).toContain('heuristic');
    expect(report_md).toContain('llm');
  });

  test('empty calibration produces no bin rows', () => {
    const { report_md } = writeAndRead(
      makeEvalResult({ calibration: [], ece: 0 }),
    );
    // Section header still present but no bin rows
    expect(report_md).toContain('Expected Calibration Error: 0.000');
  });
});

// ── latexTables (tested through writeEval file content) ────────────────

describe('latexTables', () => {
  test('output is well-formed LaTeX', () => {
    const { tables_tex } = writeAndRead(makeEvalResult());
    expect(tables_tex).toContain('\\begin{table}');
    expect(tables_tex).toContain('\\end{table}');
    expect(tables_tex).toContain('\\toprule');
    expect(tables_tex).toContain('\\midrule');
    expect(tables_tex).toContain('\\bottomrule');
  });

  test('contains caption with mode and corpus basename', () => {
    const { tables_tex } = writeAndRead(makeEvalResult());
    expect(tables_tex).toContain('no\\_llm');
    expect(tables_tex).toContain('test'); // corpus basename
  });

  test('overall metrics table has Precision/Recall/F1 rows', () => {
    const { tables_tex } = writeAndRead(makeEvalResult());
    expect(tables_tex).toContain('Precision & 0.800');
    expect(tables_tex).toContain('Recall & 0.800');
    expect(tables_tex).toContain('F1 & 0.800');
    expect(tables_tex).toContain('TP/FP/FN/TN & 4/1/1/4');
  });

  test('contains By flow variant table', () => {
    const { tables_tex } = writeAndRead(makeEvalResult());
    expect(tables_tex).toContain('% By flow variant');
    expect(tables_tex).toContain('Flow & n & Precision & Recall & F1');
    expect(tables_tex).toContain('direct & 5');
  });

  test('contains By functional variant table', () => {
    const { tables_tex } = writeAndRead(makeEvalResult());
    expect(tables_tex).toContain('% By functional variant');
    expect(tables_tex).toContain('malloc & 10');
  });

  test('contains CWE table only when >1 CWE entry', () => {
    // With only 1 CWE entry, the CWE table is SKIPPED (latexTables checks cweEntries.length > 1)
    const { tables_tex } = writeAndRead(makeEvalResult());
    expect(tables_tex).not.toContain('% By CWE');

    // With 2+ CWE entries, the CWE table appears
    const withMultiCwe = makeEvalResult({
      byCwe: {
        'CWE-401': makeEvalResult().byCwe['CWE-401'],
        'CWE-415': makeEvalResult().byCwe['CWE-401'], // reuse same shape
      },
    });
    const tex2 = writeAndRead(withMultiCwe).tables_tex;
    expect(tex2).toContain('% By CWE');
    expect(tex2).toContain('CWE-401');
    expect(tex2).toContain('CWE-415');
  });

  test('contains Calibration table', () => {
    const { tables_tex } = writeAndRead(makeEvalResult());
    expect(tables_tex).toContain('% Calibration');
    expect(tables_tex).toContain('ECE = 0.123');
  });

  test('empty breakdowns skip optional tables but overall + flow always present', () => {
    const { tables_tex } = writeAndRead(
      makeEvalResult({ byFlowVariant: {}, byFunctionalVariant: {}, byCwe: {}, calibration: [] }),
    );
    // Overall table is always present
    expect(tables_tex).toContain('% Overall metrics');
    expect(tables_tex).toContain('\\begin{table}');
    expect(tables_tex).toContain('\\bottomrule');

    // Flow variant table has no guard (always emitted)
    expect(tables_tex).toContain('% By flow variant');

    // Functional variant table HAS a guard (length > 0) → absent
    expect(tables_tex).not.toContain('% By functional variant');
    // CWE table has guard (length > 1) → absent
    expect(tables_tex).not.toContain('% By CWE');
    // Calibration table has guard (count > 0) → absent
    expect(tables_tex).not.toContain('% Calibration');
  });
});

// ── metricsCsv (tested through writeEval file content) ─────────────────

describe('metricsCsv', () => {
  test('has CSV header with expected columns', () => {
    const { metrics_csv } = writeAndRead(makeEvalResult());
    const lines = metrics_csv.trim().split('\n');
    expect(lines[0]).toBe('scope,n,tp,fp,fn,tn,precision,recall,f1,accuracy,specificity,fpr,mcc');
  });

  test('has overall row', () => {
    const { metrics_csv } = writeAndRead(makeEvalResult());
    const lines = metrics_csv.trim().split('\n');
    const overall = lines.find((l) => l.startsWith('overall,'));
    expect(overall).toBeDefined();
    expect(overall).toContain(',4,1,1,4,');
  });

  test('has flow variant rows', () => {
    const { metrics_csv } = writeAndRead(makeEvalResult());
    const lines = metrics_csv.trim().split('\n');
    expect(lines.some((l) => l.startsWith('flow:direct,'))).toBe(true);
  });

  test('has functional variant rows', () => {
    const { metrics_csv } = writeAndRead(makeEvalResult());
    const lines = metrics_csv.trim().split('\n');
    expect(lines.some((l) => l.startsWith('func:malloc,'))).toBe(true);
  });

  test('has CWE rows', () => {
    const { metrics_csv } = writeAndRead(makeEvalResult());
    const lines = metrics_csv.trim().split('\n');
    expect(lines.some((l) => l.startsWith('cwe:CWE-401,'))).toBe(true);
  });

  test('correct number of data rows (1 overall + N flow + N func + N cwe)', () => {
    const { metrics_csv } = writeAndRead(makeEvalResult());
    const lines = metrics_csv.trim().split('\n');
    // header + 1 overall + 1 flow + 1 func + 1 cwe = 5
    expect(lines).toHaveLength(5);
  });

  test('empty breakdowns -> only overall row', () => {
    const { metrics_csv } = writeAndRead(
      makeEvalResult({ byFlowVariant: {}, byFunctionalVariant: {}, byCwe: {} }),
    );
    const lines = metrics_csv.trim().split('\n');
    // header + 1 overall = 2
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('scope');
    expect(lines[1]).toContain('overall');
  });
});

// ── rowsCsv (tested through writeEval file content) ────────────────────

describe('rowsCsv', () => {
  test('has CSV header with expected columns', () => {
    const { rows_csv } = writeAndRead(makeEvalResult());
    const header = rows_csv.trim().split('\n')[0];
    expect(header).toBe('id,status,cwe,flowVariant,functionalVariant,tp,fp,fn,tn,candidates,flagged,durationMs,tokens,scanId,error');
  });

  test('contains case data row', () => {
    const { rows_csv } = writeAndRead(makeEvalResult());
    const lines = rows_csv.trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 data row
    expect(lines[1]).toContain('case1');
    expect(lines[1]).toContain('ok');
    expect(lines[1]).toContain('CWE-401');
  });

  test('multiple rows produce correct count', () => {
    const { rows_csv } = writeAndRead(
      makeEvalResult({
        rows: [makeRow({ id: 'case1' }), makeRow({ id: 'case2', status: 'error', error: 'timeout' })],
      }),
    );
    const lines = rows_csv.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 data
    expect(lines[2]).toContain('timeout');
  });

  test('escapes fields with commas or quotes', () => {
    const { rows_csv } = writeAndRead(
      makeEvalResult({
        rows: [makeRow({ id: 'case1', error: 'error, with "quotes"' })],
      }),
    );
    const line = rows_csv.trim().split('\n')[1];
    expect(line).toContain('"error, with ""quotes"""');
  });

  test('empty rows -> header only', () => {
    const { rows_csv } = writeAndRead(makeEvalResult({ rows: [] }));
    const lines = rows_csv.trim().split('\n');
    expect(lines).toHaveLength(1); // header only
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('empty breakdowns and calibration do not cause errors', () => {
    expect(() =>
      writeAndRead(
        makeEvalResult({
          byFlowVariant: {},
          byFunctionalVariant: {},
          byCwe: {},
          calibration: [],
          ece: 0,
        }),
      ),
    ).not.toThrow();
  });

  test('mode with dynamic enabled appears in report and LaTeX', () => {
    const r = makeEvalResult({ mode: 'llm_assisted', dynamic: 'selective' });
    const { report_md, tables_tex } = writeAndRead(r);
    expect(report_md).toContain('+dynamic(selective)');
    expect(tables_tex).toContain('+ dynamic');
  });

  test('zero-count rows produce valid metrics', () => {
    const zeroResult = makeEvalResult({
      overall: { total: 0, tp: 0, fp: 0, fn: 0, tn: 0, precision: 0, recall: 0, f1: 0, accuracy: 0, specificity: 0, fpr: 0, mcc: 0 },
      rows: [],
      samples: [],
    });
    const { metrics_json, report_md, tables_tex, metrics_csv } = writeAndRead(zeroResult);
    const parsed = JSON.parse(metrics_json);
    expect(parsed.overall.tp).toBe(0);
    expect(report_md).toContain('TP = 0');
    expect(tables_tex).toContain('0/0/0/0');
    expect(metrics_csv).toContain('overall,0,0,0,0,0');
  });

  test('no_llm mode shows — for model in provenance', () => {
    const r = makeEvalResult({
      provenance: { gitCommit: 'abc1234', toolVersions: { clang: '18.1.0' }, runs: 1 },
    });
    const { report_md } = writeAndRead(r);
    expect(report_md).toContain('— (no_llm)');
  });
});
