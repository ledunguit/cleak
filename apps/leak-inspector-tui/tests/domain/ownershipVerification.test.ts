import { describe, expect, test } from 'vitest';
import { buildParameterConsumptionHarnessSource, classifyOwnershipParameterRun, _internal } from '../../src/domain/ownershipVerification';
import type { Signature } from '../../src/domain/allocatorVerification';
import type { LeakBundle } from '@cleak/common/types';

const { hasLeakShapedEvidence } = _internal;

function bundle(staticEvidence?: LeakBundle['staticEvidence']): LeakBundle {
  return {
    bundleId: 'b1',
    candidate: { id: '', function_name: 'f', file_path: '/x.c', line_number: 8, allocation_site: '', allocation_type: 'malloc', confidence: 'medium', context: '' },
    evidence: [],
    status: 'pending' as any,
    createdAt: '',
    updatedAt: '',
    staticEvidence,
  };
}

describe('buildParameterConsumptionHarnessSource', () => {
  test('passes a generic heap block into the flagged parameter index, defaults for the others', () => {
    const sig: Signature = {
      filePath: '/repo/pool.c',
      returnType: 'void',
      isStaticLinkage: false,
      parameters: [
        { name: 'ctx', type: 'pool_t *', isPointer: true },
        { name: 'item', type: 'void *', isPointer: true },
      ],
    };
    const src = buildParameterConsumptionHarnessSource('pool_release', sig, '/analyzer/pool.c', 1);
    expect(src).toContain('void *heap_block = malloc(64);');
    expect(src).toContain('pool_release(NULL, (void*)heap_block)'); // param 0 (ctx) gets the usual default, param 1 gets the heap block
    expect(src).toContain('extern void pool_release(pool_t *, void *);');
    expect(src).not.toContain('#include "'); // external linkage — no source #include
  });

  test('static linkage #includes the defining file', () => {
    const sig: Signature = {
      filePath: '/repo/pool.c',
      returnType: 'void',
      isStaticLinkage: true,
      parameters: [{ name: 'item', type: 'void *', isPointer: true }],
    };
    const src = buildParameterConsumptionHarnessSource('pool_release', sig, '/analyzer/pool.c', 0);
    expect(src).toContain('#include "/analyzer/pool.c"');
    expect(src).toContain('pool_release((void*)heap_block)');
  });
});

const finding = (kind: string) => ({ kind });

describe('classifyOwnershipParameterRun — INVERTED polarity vs classifyAllocatorRun', () => {
  test('build/run failure → unverified', () => {
    expect(classifyOwnershipParameterRun(false, [])).toBe('unverified');
  });
  test('SEGV/overflow/abort → unverified (bad synthesized args for OTHER params, not evidence)', () => {
    expect(classifyOwnershipParameterRun(true, [finding('SEGV on unknown address')])).toBe('unverified');
  });
  test('a leak → REFUTED (the function did NOT free/consume the parameter as claimed)', () => {
    expect(classifyOwnershipParameterRun(true, [finding('detected memory leaks')])).toBe('refuted');
  });
  test('clean run → CONFIRMED (the function did free/consume the parameter)', () => {
    expect(classifyOwnershipParameterRun(true, [])).toBe('confirmed');
  });
});

describe('hasLeakShapedEvidence — the load-bearing gate', () => {
  test('an unpaired alloc/free pair is leak-shaped', () => {
    const b = bundle({ allocFreePairs: [{ variable: 'p', allocCall: 'malloc', allocLine: 1, allocFile: '/x.c', freeLine: null, freeFunction: null, bindsToNewVariable: true, status: 'unpaired' }], feasibleLeakPaths: [], earlyReturnCount: 0, leakyExitPaths: 0 });
    expect(hasLeakShapedEvidence(b, {})).toBe(true);
  });

  test('a reachable, risky feasible leak path is leak-shaped', () => {
    const b = bundle({ allocFreePairs: [], feasibleLeakPaths: [{ kind: 'return', exitLine: 10, reachable: true, conditions: [], unreconciledAllocations: [], leakRisk: 'high', narrative: '', feasibilityChecked: 'heuristic' }], earlyReturnCount: 0, leakyExitPaths: 0 });
    expect(hasLeakShapedEvidence(b, {})).toBe(true);
  });

  test('a fully paired allocation with no feasible paths is NOT leak-shaped', () => {
    const b = bundle({ allocFreePairs: [{ variable: 'p', allocCall: 'malloc', allocLine: 1, allocFile: '/x.c', freeLine: 5, freeFunction: 'free', bindsToNewVariable: true, status: 'paired' }], feasibleLeakPaths: [], earlyReturnCount: 0, leakyExitPaths: 0 });
    expect(hasLeakShapedEvidence(b, {})).toBe(false);
  });

  test('loose staticContext fallback: allocation with no explicit free is leak-shaped', () => {
    const b = bundle(undefined);
    expect(hasLeakShapedEvidence(b, { allocations: ['malloc at line 1'], hasExplicitFree: false })).toBe(true);
  });

  test('no evidence at all is NOT leak-shaped', () => {
    const b = bundle(undefined);
    expect(hasLeakShapedEvidence(b, {})).toBe(false);
  });
});
