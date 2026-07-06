import { describe, expect, test } from 'bun:test';
import {
  allocatorFamily,
  correlateEvidence,
  deriveDynamicFields,
  evidenceAllocatorName,
  isCorrelated,
} from '../../src/analysis/dynamic-evidence';
import { DynamicLeakKind, ToolKind, type LeakCandidate, type LeakEvidence } from '../../src/types';

function candidate(p: Partial<LeakCandidate>): LeakCandidate {
  return {
    id: 'c1',
    function_name: 'foo',
    file_path: 'src/foo.c',
    line_number: 100,
    allocation_site: 'malloc(…)',
    allocation_type: 'malloc',
    confidence: 'high' as LeakCandidate['confidence'],
    context: '',
    ...p,
  };
}

function evidence(p: Partial<LeakEvidence>): LeakEvidence {
  return {
    tool: ToolKind.LSAN,
    runId: 'r1',
    function_name: 'foo',
    file_path: 'src/foo.c',
    line_number: 100,
    bytes_lost: 100,
    blocks_lost: 1,
    severity: 'error',
    stack_trace: '',
    raw_output: '',
    leakKind: DynamicLeakKind.DEFINITELY_LOST,
    ...p,
  };
}

describe('fileMatches (via correlateEvidence) — path-boundary, not raw suffix', () => {
  test('exact same path → file_line_exact', () => {
    const c = correlateEvidence(evidence({ file_path: 'src/foo.c', line_number: 100 }), candidate({}));
    expect(c.correlationMethod).toBe('file_line_exact');
    expect(c.correlationConfidence).toBe(1);
  });

  test('suffix on a directory boundary matches (analyzer-absolute vs repo-relative)', () => {
    const c = correlateEvidence(
      evidence({ file_path: '/work/repo/src/foo.c', line_number: 100 }),
      candidate({ file_path: 'src/foo.c' }),
    );
    expect(c.correlationMethod).toBe('file_line_exact');
  });

  test('REGRESSION: barfoo.c must NOT match foo.c (old endsWith bug)', () => {
    const c = correlateEvidence(
      evidence({ file_path: 'src/barfoo.c', line_number: 100, function_name: 'unrelated' }),
      candidate({ file_path: 'src/foo.c', function_name: 'foo' }),
    );
    expect(c.correlationMethod).toBe('none');
    expect(c.correlatedToCandidate).toBe(false);
  });

  test('different basename never matches even with shared tail', () => {
    const c = correlateEvidence(
      evidence({ file_path: 'a/util_foo.c', line_number: 100, function_name: 'x' }),
      candidate({ file_path: 'b/foo.c', function_name: 'y' }),
    );
    expect(c.correlationMethod).toBe('none');
  });
});

describe('graded confidence — distance decay + tie ordering', () => {
  test('file_line_near decays with distance', () => {
    const near1 = correlateEvidence(evidence({ line_number: 101 }), candidate({ line_number: 100 }));
    const near4 = correlateEvidence(evidence({ line_number: 104 }), candidate({ line_number: 100 }));
    expect(near1.correlationMethod).toBe('file_line_near');
    expect(near4.correlationMethod).toBe('file_line_near');
    expect(near1.correlationConfidence).toBeGreaterThan(near4.correlationConfidence);
    expect(near1.correlationDistanceLines).toBe(1);
    expect(near4.correlationDistanceLines).toBe(4);
  });

  test('two allocations in the same function: nearer candidate scores higher', () => {
    const ev = evidence({ line_number: 102 }); // leak reported at line 102
    const near = correlateEvidence(ev, candidate({ line_number: 100, function_name: 'foo' })); // dist 2
    const far = correlateEvidence(ev, candidate({ line_number: 96, function_name: 'foo' })); // dist 6 → function_match
    // The closer allocation correlates more strongly (higher rank or confidence).
    expect(near.correlationConfidence).toBeGreaterThan(far.correlationConfidence);
  });
});

describe('function_match across files (weaker, but still a link)', () => {
  test('same function name, different file → function_match', () => {
    const c = correlateEvidence(
      evidence({ file_path: 'other/zzz.c', function_name: 'foo', line_number: 5, allocStack: [] }),
      candidate({ file_path: 'src/foo.c', function_name: 'foo' }),
    );
    expect(c.correlationMethod).toBe('function_match');
    expect(isCorrelated(c.correlationMethod)).toBe(true);
  });
});

describe('allocator-family agreement modifier', () => {
  test('same family nudges confidence up; different family pulls it down', () => {
    const mallocStack = [{ function: 'malloc', file: null, line: null, isUserFrame: false }];
    const callocStack = [{ function: 'calloc', file: null, line: null, isUserFrame: false }];
    const agree = correlateEvidence(
      evidence({ line_number: 103, allocStack: mallocStack }),
      candidate({ line_number: 100, allocation_type: 'malloc' }),
    );
    const disagree = correlateEvidence(
      evidence({ line_number: 103, allocStack: callocStack }),
      candidate({ line_number: 100, allocation_type: 'malloc' }),
    );
    expect(agree.correlationConfidence).toBeGreaterThan(disagree.correlationConfidence);
  });

  test('allocatorFamily collapses libc wrappers and keeps custom names distinct', () => {
    expect(allocatorFamily('xmalloc')).toBe('malloc');
    expect(allocatorFamily('malloc')).toBe('malloc');
    expect(allocatorFamily('calloc')).toBe('calloc');
    expect(allocatorFamily('pool_alloc')).toBe('pool_alloc');
    expect(allocatorFamily('cJSON_New_Item')).toBeNull();
    expect(allocatorFamily('')).toBeNull();
    expect(allocatorFamily(undefined)).toBeNull();
  });

  test('evidenceAllocatorName reads the allocator frame from the backtrace', () => {
    const ev = evidence({
      allocStack: [
        { function: 'calloc', file: null, line: null, isUserFrame: false },
        { function: 'foo', file: 'src/foo.c', line: 100, isUserFrame: true },
      ],
    });
    expect(evidenceAllocatorName(ev)).toBe('calloc');
    expect(evidenceAllocatorName(evidence({ allocStack: [] }))).toBeNull();
  });
});

describe('robustness — missing line / no location', () => {
  test('a finding with no usable location does not correlate', () => {
    const c = correlateEvidence(
      evidence({ file_path: '', line_number: 0, function_name: '', allocStack: [], allocSite: undefined }),
      candidate({}),
    );
    expect(c.correlationMethod).toBe('none');
  });

  test('deriveDynamicFields recovers allocSite/stack from a raw stack_trace string', () => {
    const ev = deriveDynamicFields(
      evidence({
        allocStack: undefined,
        allocSite: undefined,
        stack_trace: 'malloc at /usr/lib/libc.so:0\nfoo at src/foo.c:100',
      }),
    );
    expect(ev.allocSite).toEqual({ file: 'src/foo.c', line: 100, function: 'foo' });
    const c = correlateEvidence(ev, candidate({ line_number: 100 }));
    expect(c.correlationMethod).toBe('file_line_exact');
  });
});
