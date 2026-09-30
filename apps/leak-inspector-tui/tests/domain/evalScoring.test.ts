import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { accumulate } from '@cleak/common/analysis/metrics';
import {
  buildCaseUniverse,
  buildUniverseAccounting,
  classifyFunction,
  classifyFinding,
  hasGroundTruth,
  isFlagged,
  mergePairedLabels,
  normalizeSymbol,
  scoreCase,
  scoreCaseUniverse,
  extraFindings,
  type LabeledCase,
  type SnapshotFinding,
} from '../../src/domain/evalScoring';

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

// LAMeD/MemHint-style: exactly one labeled flaw in an otherwise-unlabeled real
// project (no `clean` entries, real function names never contain 'good'/'bad').
const lamedCase: LabeledCase = {
  id: 'libtiff_04118f8a',
  repo_path: 'cases/x',
  cwe: 'CWE-401',
  flaws: [{ function: 'map_colortable' }],
  clean: [],
};

describe('scoreCase — real-project (LAMeD/MemHint) findings outside ground truth are NEVER scored', () => {
  test('a flag on an unlabeled function does not affect tp/fp/fn/tn either way', () => {
    const findings = [finding({ function: 'unrelated_helper', verdict: 'confirmed_leak' })];
    const cm = accumulate(scoreCase(findings, lamedCase));
    expect(cm.fp).toBe(0);
    expect(cm.tn).toBe(0);
    expect(cm.tp).toBe(0);
    expect(cm.fn).toBe(1); // the labeled flaw was never found either
  });

  test('the labeled flaw itself still scores as TP/FN normally', () => {
    const hit = accumulate(scoreCase([finding({ function: 'map_colortable', verdict: 'confirmed_leak' })], lamedCase));
    expect(hit.tp).toBe(1);
    expect(hit.fp).toBe(0);
    const miss = accumulate(scoreCase([], lamedCase));
    expect(miss.fn).toBe(1);
    expect(miss.fp).toBe(0);
  });
});

describe('extraFindings — flagged sites outside ground truth, tracked separately (never scored)', () => {
  test('a flagged finding on an unlabeled function is reported as an extra finding', () => {
    const findings = [finding({ function: 'unrelated_helper', verdict: 'confirmed_leak' })];
    const extra = extraFindings(findings, lamedCase);
    expect(extra).toHaveLength(1);
    expect(extra[0].function).toBe('unrelated_helper');
  });

  test('an UNFLAGGED unlabeled function produces no extra finding (silence is not reported either)', () => {
    const findings = [finding({ function: 'unrelated_helper', verdict: 'false_positive' })];
    expect(extraFindings(findings, lamedCase)).toHaveLength(0);
  });

  test('the labeled flaw itself is never reported as an extra finding', () => {
    const findings = [finding({ function: 'map_colortable', verdict: 'confirmed_leak' })];
    expect(extraFindings(findings, lamedCase)).toHaveLength(0);
  });

  test('multiple flagged findings on the same unlabeled function collapse to ONE extra finding', () => {
    const findings = [
      finding({ function: 'unrelated_helper', line: 5, verdict: 'confirmed_leak' }),
      finding({ function: 'unrelated_helper', line: 9, verdict: 'likely_leak' }),
    ];
    expect(extraFindings(findings, lamedCase)).toHaveLength(1);
  });

  test('on a fully dual-labeled corpus (Juliet), a good*/bad* finding is never an extra finding', () => {
    const findings = [finding({ function: 'goodG2B', verdict: 'confirmed_leak' })];
    expect(extraFindings(findings, julietCase)).toHaveLength(0);
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

describe('scoreCase — siteId for paired (McNemar) tests', () => {
  test('every sample carries a globally-unique <caseId>::<siteKey> id', () => {
    const findings = [
      finding({ function: 'CWE401_Memory_Leak__malloc_char_01_bad', verdict: 'confirmed_leak' }),
      finding({ function: 'goodG2B', verdict: 'false_positive' }),
    ];
    const samples = scoreCase(findings, julietCase);
    for (const s of samples) {
      expect(s.siteId).toBeDefined();
      expect(s.siteId!.startsWith('CWE401_Memory_Leak__malloc_char_01::')).toBe(true);
    }
    // all distinct
    const ids = samples.map((s) => s.siteId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a missed flaw (synthetic FN) gets the SAME siteId a finding would have produced', () => {
    // Function-mode: the flaw site key is the normalized function name.
    const missed = scoreCase([], julietCase).find((s) => s.actual && !s.predicted);
    expect(missed?.siteId).toBe('CWE401_Memory_Leak__malloc_char_01::cwe401_memory_leak__malloc_char_01_bad');
  });

  test('two modes on the same corpus align site-by-site by siteId', () => {
    // mode A flags the flaw; mode B misses it → paired on the same siteId.
    const a = scoreCase([finding({ function: 'CWE401_Memory_Leak__malloc_char_01_bad', verdict: 'confirmed_leak' })], julietCase);
    const b = scoreCase([], julietCase); // discovery missed it
    const aFlaw = a.find((s) => s.actual)!;
    const bFlaw = b.find((s) => s.actual)!;
    expect(aFlaw.siteId).toBe(bFlaw.siteId); // same site, different prediction
    expect(aFlaw.predicted).toBe(true);
    expect(bFlaw.predicted).toBe(false);
  });
});

describe('classifyFunction — precedence is pinned (adversarial names)', () => {
  test('explicit flaw label beats a name that also contains "good"', () => {
    const c: LabeledCase = { id: 'c', repo_path: 'p', flaws: [{ function: 'badData_goodSink' }], clean: [] };
    expect(classifyFunction('badData_goodSink', c)).toBe('bad'); // explicit label wins over naming
  });
  test('in the NAMING fallback only, "good" is checked before "bad"', () => {
    // No explicit label for this name → falls through to the convention, where the
    // current rule returns "good" first. Pinned so a future reorder is a conscious choice.
    const c: LabeledCase = { id: 'c', repo_path: 'p', flaws: [{ function: 'other' }], clean: [] };
    expect(classifyFunction('helper_bad_good', c)).toBe('good');
  });
});

describe('scoreCase — line mode', () => {
  const lineCase: LabeledCase = {
    id: 'line-mode-1',
    repo_path: 'cases/lm',
    flaws: [{ function: 'leaky_func', line: 42 }],
    clean: [{ function: 'clean_func', line: 10 }],
  };

  test('exact line match → TP', () => {
    const f = [finding({ function: 'leaky_func', file: 'x.c', line: 42, verdict: 'confirmed_leak' })];
    const samples = scoreCase(f, lineCase);
    expect(samples.filter((s) => s.actual && s.predicted)).toHaveLength(1); // TP
  });

  test('near line mismatch → FN', () => {
    const f = [finding({ function: 'leaky_func', file: 'x.c', line: 43, verdict: 'confirmed_leak' })];
    const samples = scoreCase(f, lineCase);
    // The finding at line 43 doesn't match flaw line 42, so the flaw becomes FN
    // AND the finding at line 43 has no label → unknown → excluded
    expect(samples.filter((s) => s.actual && s.predicted)).toHaveLength(0);
  });
});

describe('scoreCase — mixed mode', () => {
  const mixedCase: LabeledCase = {
    id: 'mixed-1',
    repo_path: 'cases/mx',
    flaws: [
      { function: 'bad_fn', line: 42 },    // line-labelled
      { function: 'other_bad' },           // function-only
    ],
    clean: [{ function: 'good_fn', line: 10 }],
  };

  test('line-labelled flaw matches by line → TP', () => {
    const f = [finding({ function: 'bad_fn', line: 42 })];
    const samples = scoreCase(f, mixedCase);
    expect(samples.some((s) => s.actual && s.predicted)).toBe(true);
  });

  test('function-only flaw with no line-labelled findings → function mode fallback', () => {
    const f = [finding({ function: 'other_bad', line: 99 })];
    const samples = scoreCase(f, mixedCase);
    expect(samples.some((s) => s.actual && s.predicted)).toBe(true);
  });
});

describe('scoreCase — file-level finding', () => {
  test('finding with no function and no line is excluded (unknown)', () => {
    const c: LabeledCase = {
      id: 'file-level-1',
      repo_path: 'cases/fl',
      flaws: [{ function: 'main' }],
    };
    const f: SnapshotFinding[] = [{ verdict: 'confirmed_leak', confidence: 0.9 }]; // no function, no file, no line
    const samples = scoreCase(f, c);
    // The finding has no function/line → classifyFinding returns 'unknown' → excluded
    // The flaw 'main' has no finding → becomes FN
    expect(samples).toHaveLength(1); // just the FN
    expect(samples[0].actual).toBe(true);
    expect(samples[0].predicted).toBe(false);
  });
});

describe('scoreCase — zero findings', () => {
  test('all flaws become FN when no findings', () => {
    const c: LabeledCase = {
      id: 'zero-1',
      repo_path: 'cases/zero',
      flaws: [{ function: 'flaw_a' }, { function: 'flaw_b' }],
    };
    const samples = scoreCase([], c);
    const fns = samples.filter((s) => s.actual && !s.predicted);
    expect(fns).toHaveLength(2); // both flaws become FN
  });
});

describe('scoreCase — duplicate site collapse', () => {
  test('two findings at same function collapse to one sample', () => {
    const c: LabeledCase = {
      id: 'dup-1',
      repo_path: 'cases/dup',
      flaws: [{ function: 'flawed' }],
    };
    const f: SnapshotFinding[] = [
      { function: 'flawed', verdict: 'confirmed_leak', confidence: 0.9 },
      { function: 'flawed', verdict: 'likely_leak', confidence: 0.7 },
    ];
    const samples = scoreCase(f, c);
    const tps = samples.filter((s) => s.actual && s.predicted);
    expect(tps).toHaveLength(1); // collapsed to one TP
  });
});

describe('scoreCase — flagged wins over non-flagged', () => {
  test('flagged + non-flagged on same site → flagged wins', () => {
    const c: LabeledCase = {
      id: 'win-1',
      repo_path: 'cases/win',
      flaws: [{ function: 'ambiguous_fn' }],
    };
    const f: SnapshotFinding[] = [
      { function: 'ambiguous_fn', verdict: 'false_positive', confidence: 0.3 },
      { function: 'ambiguous_fn', verdict: 'confirmed_leak', confidence: 0.9 },
    ];
    const samples = scoreCase(f, c);
    const tp = samples.find((s) => s.actual && s.predicted);
    expect(tp).toBeDefined(); // flagged finding wins over non-flagged
    expect(tp!.confidence).toBe(0.9); // carries the flagged confidence
  });
});

// ── Todo 3: C++ symbol normalization + symmetric paired-label merge ──────────

describe('normalizeSymbol — C++ demangled symbol normalization', () => {
  test('strips namespace qualifiers, parameter lists, templates, edge underscores', () => {
    expect(normalizeSymbol('CWE401_Memory_Leak__char_calloc_43::badSource(char*&)')).toBe('badsource');
    expect(normalizeSymbol('CWE401_Memory_Leak__char_calloc_72::bad()')).toBe('bad');
    expect(normalizeSymbol('(anonymous namespace)::goodG2B')).toBe('goodg2b');
    expect(normalizeSymbol('ns::helper<std::string>::alloc<int>()')).toBe('alloc');
    expect(normalizeSymbol('_leading_and_trailing_')).toBe('leading_and_trailing');
    expect(normalizeSymbol('  badSink  ')).toBe('badsink');
  });

  test('plain identifiers are unchanged', () => {
    expect(normalizeSymbol('badSink')).toBe('badsink');
    expect(normalizeSymbol('CWE401_Memory_Leak__malloc_char_01_bad')).toBe('cwe401_memory_leak__malloc_char_01_bad');
    expect(normalizeSymbol('foo_bar')).toBe('foo_bar');
  });
});

describe('matching — C++ demangled findings vs plain labels (sameFunction after normalization)', () => {
  test('demangled qualified name matches its plain badSource label', () => {
    const c: LabeledCase = {
      id: 'CWE401_Memory_Leak__char_calloc_43',
      repo_path: 'p',
      flaws: [{ function: 'badSource' }],
      clean: [],
    };
    expect(classifyFunction('CWE401_Memory_Leak__char_calloc_43::badSource(char*&)', c)).toBe('bad');
  });

  test('namespaced zero-arg bad() matches label bad', () => {
    const c: LabeledCase = { id: 'x72', repo_path: 'p', flaws: [{ function: 'bad' }], clean: [] };
    expect(classifyFunction('CWE401_Memory_Leak__char_calloc_72::bad()', c)).toBe('bad');
  });

  test('qualified good symbol matches its clean label', () => {
    const c: LabeledCase = {
      id: 'g1',
      repo_path: 'p',
      flaws: [{ function: 'bad' }],
      clean: [{ function: 'goodG2B' }],
    };
    expect(classifyFunction('ns::goodG2B(char*)', c)).toBe('good');
  });

  test('plain identifiers: existing matching behavior unchanged (boundary suffix rules intact)', () => {
    expect(classifyFunction('badSink', { id: 'p1', repo_path: 'p', flaws: [{ function: 'badSink' }], clean: [] })).toBe('bad');
    expect(classifyFunction('tc_CWE401_x_01_bad', { id: 'p2', repo_path: 'p', flaws: [{ function: 'CWE401_x_01_bad' }], clean: [] })).toBe('bad');
    expect(classifyFunction('domain', { id: 'p3', repo_path: 'p', flaws: [{ function: 'main' }], clean: [] })).toBe('unknown');
  });

  test('no false merge: foo_bar matches neither bad nor clean labels', () => {
    const c: LabeledCase = {
      id: 'n1',
      repo_path: 'p',
      flaws: [{ function: 'bad' }],
      clean: [{ function: 'goodG2B' }],
    };
    expect(classifyFunction('foo_bar', c)).toBe('unknown');
  });
});

describe('scoreCase — demangled dynamic frame no longer triple-counts one leak', () => {
  // Real B2 defect instance: labels `bad` + `badSource`, one dynamic finding
  // `CWE401_…_43::badSource(char*&)`. Pre-fix: TP via the includes('bad')
  // fallback at a THIRD site + synthetic FNs for both labels (tp=1, fn=2).
  test('demangled frame matches badSource; only the genuinely-unpaired `bad` label stays a synthetic FN', () => {
    const c: LabeledCase = {
      id: 'CWE401_Memory_Leak__char_calloc_43',
      repo_path: 'p',
      flaws: [{ function: 'bad' }, { function: 'badSource' }],
      clean: [],
    };
    const f: SnapshotFinding[] = [
      finding({ function: 'CWE401_Memory_Leak__char_calloc_43::badSource(char*&)', verdict: 'confirmed_leak' }),
    ];
    const cm = accumulate(scoreCase(f, c));
    expect(cm.tp).toBe(1);
    expect(cm.fn).toBe(1); // pre-fix this was 2 — the double-count
    expect(cm.fp).toBe(0);
  });
});

describe('mergePairedLabels — symmetric paired-label merge (label↔label, both directions)', () => {
  test('paired labels bad + <CASE>_bad collapse to ONE site (real census pair shape)', () => {
    const merged = mergePairedLabels(['bad', 'CWE401_Memory_Leak__char_calloc_81_bad']);
    expect(merged).toHaveLength(1);
    expect(merged[0].site).toBe('bad');
    expect([...merged[0].members].sort()).toEqual(['CWE401_Memory_Leak__char_calloc_81_bad', 'bad']);
  });

  test('symmetric in input order, deterministic in output order, per-class grouping preserved', () => {
    const a = mergePairedLabels(['bad', 'CWE401_X_81_bad', 'goodG2B', 'CWE401_X_81_goodG2B']);
    const b = mergePairedLabels(['CWE401_X_81_goodG2B', 'goodG2B', 'CWE401_X_81_bad', 'bad']);
    expect(a.map((m) => m.site)).toEqual(b.map((m) => m.site));
    expect(a.map((m) => m.site)).toEqual(['bad', 'goodg2b']);
    expect(a.find((m) => m.site === 'bad')!.members).toHaveLength(2);
    expect(a.find((m) => m.site === 'goodg2b')!.members).toHaveLength(2);
  });

  test('non-matching labels stay separate (no false merge)', () => {
    const merged = mergePairedLabels(['badSink', 'bad', 'badsink_extra']);
    expect(merged).toHaveLength(3);
  });

  test('empty input yields no sites', () => {
    expect(mergePairedLabels([])).toEqual([]);
  });
});

// ── Todo 4: fixed-universe scoring (D1-refined) ──────────────────────────────

describe('scoreCaseUniverse — fixed universe, one sample per labeled site', () => {
  test('all four cells reachable: tp/fn from unflagged+flagged bad sites, fp/tn from good sites', () => {
    const sites = buildCaseUniverse({ bad: ['leak_one', 'leak_two'], good: ['clean_one', 'clean_two'] });
    const findings: SnapshotFinding[] = [
      finding({ function: 'leak_one', verdict: 'confirmed_leak' }), // bad + flagged → TP
      finding({ function: 'clean_one', verdict: 'confirmed_leak' }), // good + flagged → FP
      // leak_two: never reported → FN; clean_two: never reported → TN
    ];
    const r = scoreCaseUniverse(findings, 'case4', sites);
    expect(r.samples).toHaveLength(4);
    expect(r.flaggedUnlabeled).toHaveLength(0);
    const acct = buildUniverseAccounting([r], 2, 2);
    expect([acct.tp, acct.fp, acct.fn, acct.tn]).toEqual([1, 1, 1, 1]);
    expect(acct.totalSamples).toBe(4);
    expect(acct.mergedLabelGroups).toBe(0);
    expect(acct.exclusions).toEqual([]);
  });

  test('siteId universe is IDENTICAL across configurations; only tp/fp move', () => {
    const sites = buildCaseUniverse({ bad: ['bad', 'CWE401_X_bad'], good: ['goodG2B'] });
    const configA = scoreCaseUniverse(
      [finding({ function: 'bad', verdict: 'confirmed_leak' })],
      'caseA',
      sites,
    );
    const configB = scoreCaseUniverse(
      [finding({ function: 'goodG2B', verdict: 'confirmed_leak' })],
      'caseA',
      sites,
    );
    const idsA = configA.samples.map((s) => s.siteId).sort();
    const idsB = configB.samples.map((s) => s.siteId).sort();
    expect(idsA).toEqual(idsB);
    const a = accumulate(configA.samples);
    const b = accumulate(configB.samples);
    expect([a.tp, a.fp]).toEqual([1, 0]);
    expect([b.tp, b.fp]).toEqual([0, 1]);
  });

  test('B2 double-count structurally impossible: paired labels → ONE site, ONE TP, ZERO synthetic FN', () => {
    // Real census pair shape (case CWE401_Memory_Leak__char_calloc_81): the
    // demangled dynamic frame matches the merged site; no finding-derived
    // samples can exist, so no synthetic FN can appear.
    const sites = buildCaseUniverse({ bad: ['bad', 'CWE401_Memory_Leak__char_calloc_81_bad'], good: [] });
    const r = scoreCaseUniverse(
      [finding({ function: 'CWE401_Memory_Leak__char_calloc_81::bad(char*&)', verdict: 'confirmed_leak' })],
      'CWE401_Memory_Leak__char_calloc_81',
      sites,
    );
    expect(r.samples).toHaveLength(1); // universe size, NOT findings count
    expect(r.samples[0].actual).toBe(true);
    expect(r.samples[0].predicted).toBe(true);
    const cm = accumulate(r.samples);
    expect(cm).toEqual({ tp: 1, fp: 0, fn: 0, tn: 0 });
    expect(r.flaggedUnlabeled).toHaveLength(0);
  });

  test('unmerged distinct labels still yield exactly universe-size samples (char_calloc_43 shape)', () => {
    const sites = buildCaseUniverse({ bad: ['bad', 'badSource'], good: [] });
    const r = scoreCaseUniverse(
      [finding({ function: 'CWE401_Memory_Leak__char_calloc_43::badSource(char*&)', verdict: 'confirmed_leak' })],
      'CWE401_Memory_Leak__char_calloc_43',
      sites,
    );
    expect(r.samples).toHaveLength(2);
    const cm = accumulate(r.samples);
    expect(cm).toEqual({ tp: 1, fp: 0, fn: 1, tn: 0 }); // never 1 TP + 2 FN
  });

  test('flagged finding at an unlabeled function → flaggedUnlabeled entry, NO sample', () => {
    const sites = buildCaseUniverse({ bad: ['bad'], good: [] });
    const r = scoreCaseUniverse(
      [
        finding({ function: 'action', verdict: 'confirmed_leak' }), // the real B1 unlabeled helper
        finding({ function: 'action', verdict: 'likely_leak', line: 99 }), // same site, deduped
        finding({ function: 'other_helper', verdict: 'confirmed_leak' }),
      ],
      'caseU',
      sites,
    );
    expect(r.samples.map((s) => s.siteId)).toEqual(['caseU::bad']);
    expect(r.flaggedUnlabeled).toHaveLength(2);
    expect(r.flaggedUnlabeled[0]).toEqual({ caseId: 'caseU', site: 'action', reason: 'no-label' });
    expect(r.flaggedUnlabeled.every((e) => e.reason === 'no-label')).toBe(true);
  });

  test('unflagged finding at an unlabeled function counts nowhere', () => {
    const sites = buildCaseUniverse({ bad: ['bad'], good: [] });
    const r = scoreCaseUniverse([finding({ function: 'helper', verdict: 'false_positive' })], 'caseS', sites);
    expect(r.samples).toHaveLength(1);
    expect(r.flaggedUnlabeled).toHaveLength(0);
  });
});

describe('universe census equality — reconstruction must equal universe-census.json (Todo 1 artifact)', () => {
  // Root lookup by marker file: robust to whichever directory vitest is invoked from.
  const findRoot = (): string => {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      if (existsSync(`${dir}/demo/juliet_cwe401/corpus_manifest.json`)) return dir;
      dir = `${dir}/..`;
    }
    return process.cwd();
  };
  const root = findRoot();
  const manifestPath = `${root}/demo/juliet_cwe401/corpus_manifest.json`;
  const censusPath = `${root}/.omo/evidence/scoring-universe-refactor/universe-census.json`;
  // Both files are pinned chain inputs (git-ignored); skip in bare checkouts.
  const available = existsSync(manifestPath) && existsSync(censusPath);

  test.skipIf(!available)('mergePairedLabels over the manifest reproduces every per-case site list + the totals', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      cases: Array<{ id: string; flaws?: Array<{ function: string }>; clean?: Array<{ function: string }> }>;
    };
    const census = JSON.parse(readFileSync(censusPath, 'utf-8')) as {
      merged: { bad: number; good: number; total: number };
      perCaseSites: Record<string, { bad: string[]; good: string[] }>;
    };

    let bad = 0;
    let good = 0;
    for (const c of manifest.cases) {
      const sites = buildCaseUniverse({
        bad: (c.flaws ?? []).map((f) => f.function),
        good: (c.clean ?? []).map((f) => f.function),
      });
      const caseId = c.id;
      const expected = census.perCaseSites[caseId];
      expect(expected, `census has per-case sites for ${caseId}`).toBeDefined();
      // Set equality: the census lists sites in first-seen order; the
      // reconstruction is representative-sorted. Sorted comparison also pins
      // determinism — any content drift still fails.
      const sorted = (xs: string[]) => [...xs].sort();
      expect(sorted(sites.bad.map((s) => `${caseId}::${s.site}`))).toEqual(sorted(expected.bad));
      expect(sorted(sites.good.map((s) => `${caseId}::${s.site}`))).toEqual(sorted(expected.good));
      bad += sites.bad.length;
      good += sites.good.length;
    }
    // The census is the authority — these are ITS numbers, re-read at runtime.
    expect(bad).toBe(census.merged.bad);
    expect(good).toBe(census.merged.good);
    expect(census.merged.total).toBe(census.merged.bad + census.merged.good);
  });
});
