import { describe, expect, test } from 'bun:test';
import { accumulate } from '@mcpvul/common/analysis/metrics';
import {
  classifyFunction,
  classifyFinding,
  hasGroundTruth,
  isFlagged,
  scoreCase,
  type LabeledCase,
  type SnapshotFinding,
} from './evalScoring';

const finding = (over: Partial<SnapshotFinding> = {}): SnapshotFinding => ({
  function: 'f',
  file: 'x.c',
  line: 10,
  verdict: 'confirmed_leak',
  confidence: 0.9,
  ...over,
});

// A Juliet-style function-mode case: one _bad flaw, two good* clean functions.
const julietCase: LabeledCase = {
  id: 'CWE401_Memory_Leak__malloc_char_01',
  repo_path: 'cases/x',
  cwe: 'CWE-401',
  flaws: [{ function: 'CWE401_Memory_Leak__malloc_char_01_bad', cwe: 'CWE-401' }],
  clean: [{ function: 'goodG2B' }, { function: 'goodB2G' }],
};

describe('isFlagged', () => {
  test('only confirmed/likely count as a positive prediction', () => {
    expect(isFlagged('confirmed_leak')).toBe(true);
    expect(isFlagged('likely_leak')).toBe(true);
    expect(isFlagged('false_positive')).toBe(false);
    expect(isFlagged('uncertain')).toBe(false);
    expect(isFlagged(undefined)).toBe(false);
  });
});

describe('classifyFunction (function mode + Juliet fallback)', () => {
  test('explicit flaw/clean labels win', () => {
    expect(classifyFunction('CWE401_Memory_Leak__malloc_char_01_bad', julietCase)).toBe('bad');
    expect(classifyFunction('goodG2B', julietCase)).toBe('good');
  });
  test('Juliet naming fallback for unlabeled functions', () => {
    const c: LabeledCase = { id: 'c', repo_path: 'p', flaws: [], clean: [] };
    // hasGroundTruth is false here, so classifyFinding would skip — but classifyFunction itself
    // still applies the naming convention, which is what discovery-time labeling relies on.
    expect(classifyFunction('helper_bad', c)).toBe('bad');
    expect(classifyFunction('helper_goodB2G', c)).toBe('good');
    expect(classifyFunction('unrelated', c)).toBe('unknown');
  });
  test('tightened matching: "domain" must NOT match flaw "main"', () => {
    const c: LabeledCase = { id: 'c', repo_path: 'p', flaws: [{ function: 'main' }], clean: [] };
    expect(classifyFunction('domain', c)).toBe('unknown'); // bare endsWith would have said 'bad'
    expect(classifyFunction('main', c)).toBe('bad');
  });
  test('boundary suffix still matches testcase-prefixed Juliet names', () => {
    // discovery may report the function with an extra prefix segment
    const c: LabeledCase = { id: 'c', repo_path: 'p', flaws: [{ function: 'CWE401_x_01_bad' }], clean: [] };
    expect(classifyFunction('tc_CWE401_x_01_bad', c)).toBe('bad'); // sep '_' → boundary match
  });
});

describe('scoreCase — one sample per ground-truth site', () => {
  test('duplicate findings in the SAME bad function count as ONE true positive', () => {
    const findings = [
      finding({ function: 'CWE401_Memory_Leak__malloc_char_01_bad', line: 10 }),
      finding({ function: 'CWE401_Memory_Leak__malloc_char_01_bad', line: 14 }),
      finding({ function: 'CWE401_Memory_Leak__malloc_char_01_bad', line: 18 }),
    ];
    const cm = accumulate(scoreCase(findings, julietCase));
    expect(cm.tp).toBe(1); // NOT 3 — dedup by enclosing function
    expect(cm.fp).toBe(0);
  });

  test('flagged finding in a good function is a single false positive', () => {
    const findings = [
      finding({ function: 'goodG2B', verdict: 'confirmed_leak' }),
      finding({ function: 'goodG2B', verdict: 'likely_leak' }),
    ];
    const cm = accumulate(scoreCase(findings, julietCase));
    expect(cm.fp).toBe(1);
    expect(cm.tp).toBe(0);
  });

  test('unflagged candidate in a good function is a true negative', () => {
    const cm = accumulate(scoreCase([finding({ function: 'goodB2G', verdict: 'false_positive' })], julietCase));
    expect(cm.tn).toBe(1);
    expect(cm.fp).toBe(0);
  });

  test('a labeled flaw with NO finding is counted as a false negative', () => {
    const cm = accumulate(scoreCase([], julietCase));
    expect(cm.fn).toBe(1); // the _bad flaw was missed
    expect(cm.tp).toBe(0);
  });

  test('any flagged finding at a site makes the site a positive prediction', () => {
    const findings = [
      finding({ function: 'CWE401_Memory_Leak__malloc_char_01_bad', verdict: 'false_positive' }),
      finding({ function: 'CWE401_Memory_Leak__malloc_char_01_bad', verdict: 'confirmed_leak' }),
    ];
    const cm = accumulate(scoreCase(findings, julietCase));
    expect(cm.tp).toBe(1);
    expect(cm.fn).toBe(0);
  });
});

describe('scoreCase — line mode (hand-labeled corpus)', () => {
  const lineCase: LabeledCase = {
    id: 'demo',
    repo_path: 'cases/demo',
    flaws: [{ function: 'process', file: 'a.c', line: 12 }],
    clean: [{ function: 'process', file: 'a.c', line: 20 }],
  };

  test('classifyFinding matches by exact line; unlabeled allocation is unknown (excluded)', () => {
    expect(classifyFinding(finding({ file: 'a.c', line: 12 }), lineCase)).toBe('bad');
    expect(classifyFinding(finding({ file: 'a.c', line: 20 }), lineCase)).toBe('good');
    expect(classifyFinding(finding({ file: 'a.c', line: 99 }), lineCase)).toBe('unknown');
  });

  test('two allocations in one function are scored independently by line', () => {
    const findings = [
      finding({ file: 'a.c', line: 12, verdict: 'confirmed_leak' }), // the flaw → TP
      finding({ file: 'a.c', line: 20, verdict: 'false_positive' }), // the clean site → TN
      finding({ file: 'a.c', line: 99, verdict: 'confirmed_leak' }), // unlabeled → excluded
    ];
    const cm = accumulate(scoreCase(findings, lineCase));
    expect(cm).toEqual({ tp: 1, fp: 0, fn: 0, tn: 1 });
  });
});

describe('hasGroundTruth', () => {
  test('true when flaws or clean labels exist', () => {
    expect(hasGroundTruth(julietCase)).toBe(true);
    expect(hasGroundTruth({ id: 'x', repo_path: 'p', expected_leak_count: 2 })).toBe(false);
  });
});
