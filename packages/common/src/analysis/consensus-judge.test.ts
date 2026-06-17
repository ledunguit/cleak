import { describe, expect, test } from 'bun:test';
import {
  combineVerdicts,
  deriveFusion,
  judgeByConsensus,
  type ConsensusConfig,
  type EvidenceFusion,
} from './consensus-judge';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '../types';

/** A scripted sample/heuristic verdict. */
const v = (verdict: string, confidence = 0.8, tool: ToolKind = ToolKind.LLM): VerdictResult => ({
  verdict: verdict as InvestigationVerdict,
  confidence,
  explanation: `${verdict} @${confidence}`,
  evidence: [],
  tool,
});

const HEUR_UNCERTAIN = v('uncertain', 0.4, ToolKind.HEURISTIC);
const HEUR_EXCULPATE = v('likely_false_positive', 0.8, ToolKind.HEURISTIC);
const NONE: EvidenceFusion = { static: 'ambiguous', dynamic: 'none' };
const cfg = (rule: ConsensusConfig['rule'], n = 3): ConsensusConfig => ({ n, rule, temperature: 0.7 });

describe('combineVerdicts — majority rule', () => {
  test('flags when a strict majority flag; verdict is the modal flagging verdict', () => {
    const out = combineVerdicts([v('confirmed_leak'), v('likely_leak'), v('likely_leak')], HEUR_UNCERTAIN, NONE, cfg('majority'));
    expect(out.verdict).toBe(InvestigationVerdict.LIKELY_LEAK); // 2× likely beats 1× confirmed
    expect(out.tool).toBe(ToolKind.CONSENSUS);
    expect(out.agreement).toBeCloseTo(1, 6);
    expect(out.samples).toHaveLength(3);
  });

  test('does NOT flag at exactly half (no strict majority)', () => {
    const out = combineVerdicts(
      [v('confirmed_leak'), v('confirmed_leak'), v('false_positive'), v('false_positive')],
      HEUR_UNCERTAIN,
      NONE,
      cfg('majority', 4),
    );
    expect(['uncertain', 'false_positive', 'likely_false_positive']).toContain(out.verdict);
    expect(out.agreement).toBeCloseTo(0.5, 6);
  });

  test('one flagging vote out of three → not flagged', () => {
    const out = combineVerdicts([v('confirmed_leak'), v('uncertain'), v('false_positive')], HEUR_UNCERTAIN, NONE, cfg('majority'));
    expect(['uncertain', 'false_positive']).toContain(out.verdict);
  });
});

describe('combineVerdicts — unanimous-to-flag rule', () => {
  test('all N flag → flagged', () => {
    const out = combineVerdicts([v('confirmed_leak'), v('confirmed_leak'), v('confirmed_leak')], HEUR_UNCERTAIN, NONE, cfg('unanimous-to-flag'));
    expect(out.verdict).toBe(InvestigationVerdict.CONFIRMED_LEAK);
    expect(out.agreement).toBe(1);
  });

  test('a single dissent downgrades to a non-flag (precision-maximizing)', () => {
    const out = combineVerdicts([v('confirmed_leak'), v('confirmed_leak'), v('uncertain')], HEUR_UNCERTAIN, NONE, cfg('unanimous-to-flag'));
    expect(['uncertain', 'likely_false_positive', 'false_positive']).toContain(out.verdict);
    expect(out.tool).toBe(ToolKind.CONSENSUS);
  });
});

describe('combineVerdicts — weighted rule (the recall↑/FP↑ lever)', () => {
  test('a clean dynamic run suppresses a flagging majority', () => {
    // 2/3 flag, but the dynamic run CLEARED this site → flagging votes are discounted.
    const fusion: EvidenceFusion = { static: 'ambiguous', dynamic: 'cleared' };
    const out = combineVerdicts([v('confirmed_leak', 0.9), v('confirmed_leak', 0.9), v('false_positive', 0.9)], HEUR_UNCERTAIN, fusion, cfg('weighted'));
    expect(out.verdict).toBe(InvestigationVerdict.FALSE_POSITIVE); // not flagged
    expect(out.overridden).toBeUndefined();
  });

  test('a confirmed runtime leak rescues a true leak from a false-positive-leaning majority', () => {
    // 1/3 flag, but dynamic CONFIRMED → the non-flag votes are discounted instead.
    const fusion: EvidenceFusion = { static: 'leak', dynamic: 'confirmed' };
    const out = combineVerdicts([v('confirmed_leak', 0.8), v('false_positive', 0.9), v('false_positive', 0.9)], HEUR_UNCERTAIN, fusion, cfg('weighted'));
    expect(out.verdict).toBe(InvestigationVerdict.CONFIRMED_LEAK); // flagged despite minority
  });
});

describe('combineVerdicts — heuristic precision override', () => {
  test('confident heuristic exculpation vetoes a consensus flag (FP suppression)', () => {
    const fusion: EvidenceFusion = { static: 'clean', dynamic: 'cleared' };
    const out = combineVerdicts([v('confirmed_leak'), v('confirmed_leak')], HEUR_EXCULPATE, fusion, cfg('majority', 2));
    expect(out.overridden).toBe(true);
    expect(out.tool).toBe(ToolKind.HEURISTIC);
    expect(out.verdict).toBe(InvestigationVerdict.LIKELY_FALSE_POSITIVE);
    expect(out.explanation).toContain('vetoed');
  });

  test('override does NOT fire when a runtime leak is correlated (dynamic confirmed)', () => {
    const fusion: EvidenceFusion = { static: 'leak', dynamic: 'confirmed' };
    const out = combineVerdicts([v('confirmed_leak'), v('confirmed_leak')], HEUR_EXCULPATE, fusion, cfg('majority', 2));
    expect(out.overridden).toBeUndefined();
    expect(out.verdict).toBe(InvestigationVerdict.CONFIRMED_LEAK);
  });

  test('override never ADDS a flag — a non-flagged consensus is left alone', () => {
    const fusion: EvidenceFusion = { static: 'clean', dynamic: 'cleared' };
    const out = combineVerdicts([v('uncertain'), v('false_positive')], HEUR_EXCULPATE, fusion, cfg('majority', 2));
    expect(out.overridden).toBeUndefined();
    expect(out.tool).toBe(ToolKind.CONSENSUS);
  });
});

describe('combineVerdicts — degenerate sampling', () => {
  test('zero usable samples → defers entirely to the heuristic', () => {
    const out = combineVerdicts([], HEUR_EXCULPATE, NONE, cfg('majority'));
    expect(out.verdict).toBe(InvestigationVerdict.LIKELY_FALSE_POSITIVE);
    expect(out.tool).toBe(ToolKind.HEURISTIC);
    expect(out.agreement).toBe(0);
  });

  test('n=1 reproduces the single sample (free single-LLM regression baseline)', () => {
    const out = combineVerdicts([v('confirmed_leak', 0.85)], HEUR_UNCERTAIN, NONE, { n: 1, rule: 'majority', temperature: 0 });
    expect(out.verdict).toBe(InvestigationVerdict.CONFIRMED_LEAK);
    expect(out.agreement).toBe(1);
  });
});

// ── deriveFusion + judgeByConsensus (need a minimal bundle) ──

const bundle = (over: Partial<LeakBundle> = {}): LeakBundle =>
  ({
    bundleId: 'b1',
    candidate: { file_path: '/nonexistent/x.c', line_number: 10, function_name: 'f', allocation_type: 'malloc', confidence: 'medium' },
    evidence: [],
    status: 'pending',
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as any;

const ev = (over: Record<string, any> = {}): any => ({
  tool: 'lsan',
  function_name: 'f',
  file_path: '/x.c',
  line_number: 10,
  bytes_lost: 0,
  blocks_lost: 0,
  severity: 'info',
  ...over,
});

describe('deriveFusion', () => {
  test('a correlated runtime leak → dynamic: confirmed', () => {
    const f = deriveFusion(bundle({ evidence: [ev({ leakKind: 'definitely_lost', severity: 'high', bytes_lost: 100, correlatedToCandidate: true })] }));
    expect(f.dynamic).toBe('confirmed');
  });

  test('a dynamic run that flagged no leak → dynamic: cleared', () => {
    const f = deriveFusion(bundle({ evidence: [ev({ leakKind: null, severity: 'info' })] }));
    expect(f.dynamic).toBe('cleared');
  });

  test('no evidence → dynamic: none', () => {
    expect(deriveFusion(bundle({})).dynamic).toBe('none');
  });

  test('an unpaired alloc→free → static: leak', () => {
    const f = deriveFusion(bundle({ staticEvidence: { allocFreePairs: [{ variable: 'p', allocCall: 'malloc', allocLine: 10, status: 'unpaired' }] } as any }));
    expect(f.static).toBe('leak');
  });

  test('ownership handed to the caller → static: clean', () => {
    const f = deriveFusion(bundle({ staticEvidence: { ownership: { role: 'allocator', ownershipCarrier: { kind: 'return_value' } } } as any }));
    expect(f.static).toBe('clean');
  });
});

describe('judgeByConsensus', () => {
  test('samples the injected judge n times and combines (majority)', async () => {
    const scripted = [v('confirmed_leak'), v('confirmed_leak'), v('false_positive')];
    let calls = 0;
    const out = await judgeByConsensus(
      bundle({}),
      undefined,
      async (i) => {
        calls++;
        return scripted[i];
      },
      cfg('majority', 3),
    );
    expect(calls).toBe(3);
    expect(out.verdict).toBe(InvestigationVerdict.CONFIRMED_LEAK);
    expect(out.tool).toBe(ToolKind.CONSENSUS);
    expect(out.samples).toHaveLength(3);
  });

  test('a sample that throws is dropped, not fatal', async () => {
    const out = await judgeByConsensus(
      bundle({}),
      undefined,
      async (i) => {
        if (i === 1) throw new Error('gateway hiccup');
        return v('confirmed_leak');
      },
      cfg('majority', 3),
    );
    expect(out.samples).toHaveLength(2); // the thrown one dropped
    expect(out.verdict).toBe(InvestigationVerdict.CONFIRMED_LEAK);
  });

  test('all samples null → falls back to the heuristic verdict', async () => {
    const out = await judgeByConsensus(bundle({}), undefined, async () => null, cfg('majority', 3));
    expect(out.agreement).toBe(0);
    expect(out.tool).toBe(ToolKind.HEURISTIC);
  });
});
