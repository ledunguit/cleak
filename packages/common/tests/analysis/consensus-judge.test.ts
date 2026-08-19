import { describe, expect, test } from 'vitest';
import {
  combineVerdicts,
  deriveFusion,
  isDecisionLocked,
  judgeByConsensus,
  type ConsensusConfig,
  type EvidenceFusion,
} from '../../src/analysis/consensus-judge';
import { LEAK_POSITIVE_VERDICTS, QuotaExhaustedError } from '../../src/analysis/judge-shared';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '../../src/types';

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

  test('a QuotaExhaustedError sample is NOT dropped — it aborts the whole consensus draw', async () => {
    let calls = 0;
    await expect(
      judgeByConsensus(
        bundle({}),
        undefined,
        async (i) => {
          calls++;
          if (i === 1) throw new QuotaExhaustedError(new Error('rate limit exceeded'));
          return v('confirmed_leak');
        },
        cfg('majority', 3),
      ),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    // A partial/degraded sample set must never be silently combined into "the
    // answer" — unlike a generic throw, this must not just drop the one slot.
    expect(calls).toBeLessThanOrEqual(3);
  });
});

// ── isDecisionLocked + earlyStop: the guarantee is "identical flag/no-flag call to
// sampling all n", verified directly against the real combineVerdicts, not a
// reimplementation — see isDecisionLocked's doc comment for what's and isn't guaranteed. ──

const isFlagged = (verdictStr: string): boolean => LEAK_POSITIVE_VERDICTS.has(verdictStr as InvestigationVerdict);

describe('isDecisionLocked', () => {
  test('majority: locked NOT-flagged once remaining votes cannot reach a majority', () => {
    // 1 flag out of 3 so far, 1 remaining — even if it flags, 2/4 is not a strict majority.
    const soFar = [v('confirmed_leak'), v('false_positive'), v('false_positive')];
    expect(isDecisionLocked(soFar, 1, cfg('majority', 4), NONE)).toBe(true);
  });

  test('majority: NOT locked while a remaining vote could still flip it', () => {
    // 1 flag out of 2 so far, 2 remaining — could end 1/4 or 3/4, still undetermined.
    const soFar = [v('confirmed_leak'), v('false_positive')];
    expect(isDecisionLocked(soFar, 2, cfg('majority', 4), NONE)).toBe(false);
  });

  test('unanimous-to-flag: locked the instant a single dissent appears, however many remain', () => {
    const soFar = [v('confirmed_leak'), v('uncertain')];
    expect(isDecisionLocked(soFar, 5, cfg('unanimous-to-flag', 7), NONE)).toBe(true);
  });

  test('unanimous-to-flag: never locked-true early — reaching "flagged" always needs every vote', () => {
    const soFar = [v('confirmed_leak'), v('confirmed_leak')];
    expect(isDecisionLocked(soFar, 1, cfg('unanimous-to-flag', 3), NONE)).toBe(false);
  });

  test('weighted: a confirmed runtime leak caps non-flag weight, locking "flagged" even with a minority so far', () => {
    const fusion: EvidenceFusion = { static: 'leak', dynamic: 'confirmed' };
    // 1 flag @0.9 vs 1 non-flag capped at 0.3*conf — even 2 more non-flag votes at full
    // (capped) weight can't out-weigh the already-decisive flag vote.
    const soFar = [v('confirmed_leak', 0.9), v('false_positive', 0.9)];
    expect(isDecisionLocked(soFar, 2, cfg('weighted', 4), fusion)).toBe(true);
  });

  test('weighted: not locked when remaining votes have full, undiscounted sway', () => {
    const soFar = [v('confirmed_leak', 0.6)];
    expect(isDecisionLocked(soFar, 3, cfg('weighted', 4), NONE)).toBe(false);
  });

  test('remaining=0 is always locked (nothing left that could change anything)', () => {
    expect(isDecisionLocked([], 0, cfg('majority', 0), NONE)).toBe(true);
  });
});

describe('earlyStop — exhaustive equivalence check against combineVerdicts on the full sample set', () => {
  // For every rule and every combination of a small, fixed set of per-slot sample verdicts,
  // simulate early-stop truncation (via isDecisionLocked over prefixes) and assert
  // combineVerdicts on the TRUNCATED samples flags the same way as on the FULL n samples —
  // the actual guarantee earlyStop relies on, checked exhaustively rather than on a few
  // hand-picked cases.
  const SLOT_VALUES: VerdictResult[] = [
    v('confirmed_leak', 0.9),
    v('confirmed_leak', 0.3),
    v('false_positive', 0.9),
    v('false_positive', 0.3),
  ];
  const N = 4;

  function* combos(n: number): Generator<VerdictResult[]> {
    if (n === 0) {
      yield [];
      return;
    }
    for (const rest of combos(n - 1)) {
      for (const s of SLOT_VALUES) yield [s, ...rest];
    }
  }

  function earlyStopTruncate(full: VerdictResult[], rule: ConsensusConfig, fusion: EvidenceFusion): VerdictResult[] {
    for (let k = 1; k <= full.length; k++) {
      const soFar = full.slice(0, k);
      if (isDecisionLocked(soFar, full.length - k, rule, fusion)) return soFar;
    }
    return full;
  }

  for (const rule of ['majority', 'unanimous-to-flag', 'weighted'] as const) {
    for (const fusion of [NONE, { static: 'leak', dynamic: 'confirmed' }, { static: 'clean', dynamic: 'cleared' }] as EvidenceFusion[]) {
      test(`${rule} / dynamic=${fusion.dynamic}: truncated-vs-full flag decision always matches (${Math.pow(SLOT_VALUES.length, N)} combos)`, () => {
        const config = cfg(rule, N);
        let checked = 0;
        for (const full of combos(N)) {
          const truncated = earlyStopTruncate(full, config, fusion);
          const fullOut = combineVerdicts(full, HEUR_UNCERTAIN, fusion, config);
          const truncOut = combineVerdicts(truncated, HEUR_UNCERTAIN, fusion, config);
          expect(isFlagged(truncOut.verdict)).toBe(isFlagged(fullOut.verdict));
          checked++;
        }
        expect(checked).toBe(Math.pow(SLOT_VALUES.length, N));
      });
    }
  }
});

describe('judgeByConsensus — earlyStop actually saves calls when the decision is obviously locked', () => {
  test('unanimous-to-flag: one early dissent stops sampling well before n', async () => {
    const scripted = [v('confirmed_leak'), v('uncertain'), v('confirmed_leak'), v('confirmed_leak'), v('confirmed_leak')];
    let calls = 0;
    const out = await judgeByConsensus(
      bundle({}),
      undefined,
      async (i) => {
        calls++;
        return scripted[i];
      },
      { n: 5, rule: 'unanimous-to-flag', temperature: 0, concurrency: 1, earlyStop: true },
    );
    expect(calls).toBeLessThan(5);
    expect(isFlagged(out.verdict)).toBe(false);
  });

  test('earlyStop:false (default) always samples all n, unchanged from before this feature existed', async () => {
    const scripted = [v('confirmed_leak'), v('uncertain'), v('confirmed_leak'), v('confirmed_leak'), v('confirmed_leak')];
    let calls = 0;
    await judgeByConsensus(
      bundle({}),
      undefined,
      async (i) => {
        calls++;
        return scripted[i];
      },
      { n: 5, rule: 'unanimous-to-flag', temperature: 0, concurrency: 1 },
    );
    expect(calls).toBe(5);
  });

  test('QuotaExhaustedError propagates through the earlyStop batch path too', async () => {
    await expect(
      judgeByConsensus(
        bundle({}),
        undefined,
        async (i) => {
          if (i === 0) throw new QuotaExhaustedError(new Error('429'));
          return v('confirmed_leak');
        },
        { n: 5, rule: 'unanimous-to-flag', temperature: 0, concurrency: 2, earlyStop: true },
      ),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });
});
