import { describe, expect, test } from 'vitest';
import { needsTargetedDynamic } from '../../src/domain/harnessEscalation';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '@cleak/common/types';
import type { StaticContextStore } from '../../src/domain/staticContext';

const verdict = (v: InvestigationVerdict, confidence: number): VerdictResult => ({
  verdict: v,
  confidence,
  explanation: '',
  evidence: [],
  tool: ToolKind.HEURISTIC,
});

function bundle(over: Partial<LeakBundle> = {}): LeakBundle {
  return {
    bundleId: 'b1',
    candidate: {
      id: '',
      function_name: 'f',
      file_path: '/x.c',
      line_number: 8,
      allocation_site: '',
      allocation_type: 'malloc',
      confidence: 'medium',
      context: '',
    },
    evidence: [],
    status: 'pending' as any,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

const storeWith = (bundleId: string): StaticContextStore => new Map([[bundleId, {}]]);
const emptyStore: StaticContextStore = new Map();

describe('needsTargetedDynamic', () => {
  test('false without a build command', () => {
    const b = bundle({ verdict: verdict(InvestigationVerdict.UNCERTAIN, 0.5) });
    expect(needsTargetedDynamic(b, storeWith('b1'), false)).toBe(false);
  });

  test('false without a verdict yet', () => {
    const b = bundle();
    expect(needsTargetedDynamic(b, storeWith('b1'), true)).toBe(false);
  });

  test('false without static context for the bundle', () => {
    const b = bundle({ verdict: verdict(InvestigationVerdict.UNCERTAIN, 0.5) });
    expect(needsTargetedDynamic(b, emptyStore, true)).toBe(false);
  });

  test('false when the cheap global run already confirmed a correlated leak', () => {
    const b = bundle({ verdict: verdict(InvestigationVerdict.UNCERTAIN, 0.5), dynamicCoverage: 'exercised_leak' });
    expect(needsTargetedDynamic(b, storeWith('b1'), true)).toBe(false);
  });

  test('false for a confident (non-borderline) verdict', () => {
    const b = bundle({ verdict: verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.95) });
    expect(needsTargetedDynamic(b, storeWith('b1'), true)).toBe(false);
  });

  test('true for a borderline verdict with static context, a build command, and no confirmed leak yet', () => {
    const b = bundle({ verdict: verdict(InvestigationVerdict.UNCERTAIN, 0.5), dynamicCoverage: 'not_exercised' });
    expect(needsTargetedDynamic(b, storeWith('b1'), true)).toBe(true);
  });

  test('true even after exercised_clean (whole-binary run missed the branch)', () => {
    const b = bundle({ verdict: verdict(InvestigationVerdict.LIKELY_LEAK, 0.5), dynamicCoverage: 'exercised_clean' });
    expect(needsTargetedDynamic(b, storeWith('b1'), true)).toBe(true);
  });

  describe('verifyConfirmedLeaks widening', () => {
    test('a confident CONFIRMED_LEAK is still skipped when the flag is off (default)', () => {
      const b = bundle({ verdict: verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.95) });
      expect(needsTargetedDynamic(b, storeWith('b1'), true, false)).toBe(false);
    });

    test('a confident CONFIRMED_LEAK is targeted when the flag is on', () => {
      const b = bundle({ verdict: verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.95) });
      expect(needsTargetedDynamic(b, storeWith('b1'), true, true)).toBe(true);
    });

    test('still skipped when the cheap global run already confirmed it, flag or not', () => {
      const b = bundle({ verdict: verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.95), dynamicCoverage: 'exercised_leak' });
      expect(needsTargetedDynamic(b, storeWith('b1'), true, true)).toBe(false);
    });

    test('FALSE_POSITIVE is never targeted even with the flag on (explicit non-goal)', () => {
      const b = bundle({ verdict: verdict(InvestigationVerdict.FALSE_POSITIVE, 0.95) });
      expect(needsTargetedDynamic(b, storeWith('b1'), true, true)).toBe(false);
    });
  });
});
