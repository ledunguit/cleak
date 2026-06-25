import { describe, expect, test } from 'bun:test';
import { foldStaticResult, type StaticContextStore } from './staticContext';
import type { LeakBundle } from '@cleak/common/types';

function bundle(id: string, file: string, fn: string, line: number): LeakBundle {
  return {
    bundleId: id,
    candidate: {
      id: '',
      function_name: fn,
      file_path: file,
      line_number: line,
      allocation_site: '',
      allocation_type: 'malloc',
      confidence: 'medium',
      context: '',
    },
    evidence: [],
    status: 'pending' as any,
    createdAt: '',
    updatedAt: '',
  };
}

describe('foldStaticResult', () => {
  const file = '/repo/session.c';
  const b = bundle('b1', file, 'session_open', 8);

  test('functionSummary → hasExplicitFree/allocations/frees/leakyExitPaths', () => {
    const store: StaticContextStore = new Map();
    foldStaticResult(
      store,
      'functionSummary',
      { filePath: file, functionName: 'session_open' },
      { summary: JSON.stringify({ leaky_exit_paths: 4 }), allocations: ['s at line 8'], frees: [] },
      [b],
    );
    expect(store.get('b1')).toMatchObject({
      hasExplicitFree: false,
      allocations: ['s at line 8'],
      frees: [],
      leakyExitPaths: 4,
    });
  });

  test('pathConstraints → feasiblePaths/constraints/earlyReturnCount (exact line match)', () => {
    const store: StaticContextStore = new Map();
    foldStaticResult(
      store,
      'pathConstraints',
      { filePath: file, lineNumber: 8 },
      { feasiblePaths: [{ a: 1 }], constraints: ['x == NULL'], earlyReturnCount: 3 },
      [b],
    );
    const c = store.get('b1')!;
    expect(c.feasiblePaths).toHaveLength(1);
    expect(c.earlyReturnCount).toBe(3);
    expect(c.constraints).toEqual(['x == NULL']);
  });

  test('astScan → earlyReturnCount/leakyExitPaths per function', () => {
    const store: StaticContextStore = new Map();
    foldStaticResult(
      store,
      'astScan',
      { filePath: file },
      { functionSummaries: [{ functionName: 'session_open', earlyReturnCount: 2, leakyExitPaths: 1 }] },
      [b],
    );
    expect(store.get('b1')).toMatchObject({ earlyReturnCount: 2, leakyExitPaths: 1 });
  });

  test('ownershipConventions → malloc_without_free when a leak rule names the function', () => {
    const store: StaticContextStore = new Map();
    foldStaticResult(
      store,
      'ownershipConventions',
      { filePath: file },
      { rules: [{ conventionType: 'missing_free', pattern: "session_open returns without freeing 'session'" }] },
      [b],
    );
    expect(store.get('b1')!.ownership).toEqual({ ownershipType: 'malloc_without_free' });
  });

  test('lenient file matching by basename; unrelated function is untouched', () => {
    const store: StaticContextStore = new Map();
    const other = bundle('b2', file, 'queue_push', 21);
    foldStaticResult(
      store,
      'functionSummary',
      { filePath: '/elsewhere/session.c', functionName: 'session_open' }, // different dir, same basename
      { allocations: ['x'], frees: ['x'] },
      [b, other],
    );
    expect(store.get('b1')!.hasExplicitFree).toBe(true);
    expect(store.has('b2')).toBe(false); // queue_push not the target function
  });

  test('result given as a JSON string is coerced', () => {
    const store: StaticContextStore = new Map();
    foldStaticResult(store, 'functionSummary', { filePath: file, functionName: 'session_open' }, JSON.stringify({ allocations: ['a'], frees: ['a'] }), [b]);
    expect(store.get('b1')!.hasExplicitFree).toBe(true);
  });
});
