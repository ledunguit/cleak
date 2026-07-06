import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadBaselineConfigs } from '../../src/domain/baselineConfig';
import { resolveCapabilities } from '../../src/domain/capabilityResolver';
import {
  isWiredNow,
  renderSweepMarkdown,
  renderSweepCsv,
  renderSweepLatex,
  type BaselineSweepRow,
} from '../../src/domain/baselineSweep';

const BASELINES_DIR = join(import.meta.dir, '../../../../configs/baselines');

describe('isWiredNow (Step-4 gate over the 9 baselines)', () => {
  const configs = loadBaselineConfigs(BASELINES_DIR);
  const wiredById = Object.fromEntries(
    configs.map((c) => [c.id, isWiredNow(resolveCapabilities(c.capabilities, { runs: c.runs })).wired]),
  );

  test('all 9 baselines are wired now (Steps 4a + 4b done)', () => {
    expect(Object.values(wiredById).every(Boolean)).toBe(true);
    expect(Object.keys(wiredById).sort()).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B6a', 'B6b', 'B7']);
  });
});

describe('table renderers', () => {
  const rows: BaselineSweepRow[] = [
    { id: 'B1', name: 'Static only', status: 'ok', ranOk: 200, caseCount: 200, runs: 1, tp: 19, fp: 3, fn: 1, tn: 65, precision: 0.806, recall: 0.906, f1: 0.853, fpPerKloc: 0.741, ece: 0.593, meanDurationMs: 1200, meanMcpCalls: 3, meanTokens: 0, totalTokens: 0 },
    { id: 'B7', name: 'Proposed', status: 'ok', ranOk: 198, caseCount: 200, runs: 3, tp: 20, fp: 2, fn: 0, tn: 66, precision: 0.79, recall: 0.95, f1: 0.86, f1Std: 0.01, fpPerKloc: 1.0, ece: 0.12, meanDurationMs: 8000, meanMcpCalls: 14, meanTokens: 5200, totalTokens: 1040000 },
    { id: 'B2', name: 'Dynamic only', status: 'skipped', skipReason: 'dynamic-only discovery not yet implemented (Step 4a)' },
  ];

  test('markdown has confusion matrix + ECE columns and mean±std for multi-run F1', () => {
    const md = renderSweepMarkdown(rows, { corpus: 'demo/juliet_cwe401', limit: 200 });
    expect(md).toContain('| TP | FP | FN | TN |');
    expect(md).toContain('| ECE |');
    expect(md).toContain('| B1 | Static only | 200/200 | 19 | 3 | 1 | 65 |');
    expect(md).toContain('0.593'); // B1 ECE
    expect(md).toContain('0.860 ± 0.010'); // B7 multi-run F1
    expect(md).toContain('_skipped: dynamic-only discovery not yet implemented (Step 4a)_');
  });

  test('markdown has a token-cost footer with the sweep grand total', () => {
    const md = renderSweepMarkdown(rows, { corpus: 'demo/juliet_cwe401', limit: 200 });
    expect(md).toContain('## Token cost (LLM)');
    expect(md).toContain('total tokens');
    expect(md).toContain('sweep total'); // grand total row (only B7 has tokens here → 1,040,000)
    expect(md).toContain('1040000');
  });

  test('csv has a header + one line per row with confusion + ece', () => {
    const csv = renderSweepCsv(rows);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'id,name,status,ranOk,caseCount,runs,tp,fp,fn,tn,precision,recall,f1,f1Std,fpPerKloc,ece,meanDurationMs,meanMcpCalls,meanTokens,totalTokens',
    );
    expect(lines).toHaveLength(1 + rows.length);
    expect(lines[1]).toContain('B1,"Static only",ok,200,200,1,19,3,1,65,');
  });

  test('latex emits only ok rows with confusion + ECE', () => {
    const tex = renderSweepLatex(rows, { corpus: 'demo/juliet_cwe401' });
    expect(tex).toContain('TP & FP & FN & TN');
    expect(tex).toContain('B1 & Static only & 19 & 3 & 1 & 65');
    expect(tex).toContain('B7 & Proposed');
    expect(tex).not.toContain('Dynamic only'); // skipped row excluded
    expect(tex).toContain('\\begin{tabular}');
  });
});
