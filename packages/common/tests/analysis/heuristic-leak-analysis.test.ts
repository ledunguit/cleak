import { describe, expect, test } from 'vitest';
import { analyzeLeakHeuristically } from '../../src/analysis/heuristic-leak-analysis';
import type { LeakBundle } from '../../src/types';
import type { CrossFileFreedVia } from '../../src/types/evidence';

/** Minimal bundle whose candidate points at `line` (1-based) of the source under test. */
function bundleAt(line: number, fn: string, crossFileFreedVia?: CrossFileFreedVia[]): LeakBundle {
  return {
    bundleId: 'b',
    candidate: {
      id: 'c',
      function_name: fn,
      file_path: '/virtual/test.c',
      line_number: line,
      allocation_site: `/virtual/test.c:${line}`,
      allocation_type: 'calloc',
      confidence: 'high',
      context: '',
    },
    evidence: [],
    ...(crossFileFreedVia
      ? { staticEvidence: { allocFreePairs: [], feasibleLeakPaths: [], earlyReturnCount: 0, leakyExitPaths: 0, crossFileFreedVia } }
      : {}),
    status: 'pending',
    createdAt: '',
    updatedAt: '',
  } as unknown as LeakBundle;
}

// Juliet flow-variant 16: `while(1){ alloc; …; break; }` runs exactly once. The
// good* variant frees in a sibling loop; the bad twin never frees.
const GOOD_LOOP = `static void goodB2G()
{
    char * data;
    data = NULL;
    while(1)
    {
        data = (char *)calloc(100, sizeof(char));
        if (data == NULL) {exit(-1);}
        break;
    }
    while(1)
    {
        free(data);
        break;
    }
}
`; // calloc is on line 7

const BAD_LOOP = `static void bad()
{
    char * data;
    data = NULL;
    while(1)
    {
        data = (char *)calloc(100, sizeof(char));
        if (data == NULL) {exit(-1);}
        break;
    }
    while(1)
    {
        ; /* no deallocation */
        break;
    }
}
`; // calloc is on line 7

// Juliet flow-variant 22: the sink that frees `data` is only PROTOTYPED here —
// defined in a sibling file (`isFreedViaCallee`'s same-file regex scan can never
// find it), so this evidence must come from `staticEvidence.crossFileFreedVia`.
const CROSS_FILE_CALLER = `void goodB2G1Sink(char * data);

static void goodB2G1()
{
    char * data;
    data = (char *)calloc(100, sizeof(char));
    goodB2G1Sink(data);
}
`; // calloc is on line 6

describe('analyzeLeakHeuristically — cross-file callee free (Juliet flow-variant 22)', () => {
  test('no crossFileFreedVia evidence: same-file scan alone cannot exonerate (regression guard for the bug)', () => {
    const a = analyzeLeakHeuristically(bundleAt(6, 'goodB2G1'), {}, CROSS_FILE_CALLER);
    expect(a.freedViaCallee).toBeUndefined();
    expect(a.structuralLikelihood).toBe('high');
  });

  test('with crossFileFreedVia evidence: exonerated, matching same-file isFreedViaCallee behavior', () => {
    const a = analyzeLeakHeuristically(
      bundleAt(6, 'goodB2G1', [{ calleeFunction: 'goodB2G1Sink', calleeFile: '/virtual/test_b.c', variable: 'data' }]),
      {},
      CROSS_FILE_CALLER,
    );
    expect(a.freedViaCallee).toEqual({ callee: 'goodB2G1Sink', variable: 'data' });
    expect(a.structuralLikelihood).toBe('low');
  });
});

// Juliet flow-variant 42: a "Source" function allocates and RETURNS the
// pointer; whether it's a leak is decided entirely by whether the DISPATCHER
// that calls it frees the assigned local. `bad()` is the real flaw
// (dispatcher drops it); `goodB2G()` is clean (dispatcher frees it) — but
// BOTH `badSource`/`goodB2GSource` look identical from a pure allocate-and-
// return read, so this is exactly the shape `findCallerAssignment`/
// `hasFreeOfVar`'s `returned && varName` branch must discriminate.
const RETURN_OWNERSHIP_SOURCE = `static char * badSource(void)
{
    char *data = (char *)calloc(100, sizeof(char));
    return data;
}

static void bad(void)
{
    char *data;
    data = badSource();
    ;
}

static char * goodB2GSource(void)
{
    char *data = (char *)calloc(100, sizeof(char));
    return data;
}

static void goodB2G(void)
{
    char *data;
    data = goodB2GSource();
    free(data);
}
`; // badSource's calloc is on line 3; goodB2GSource's calloc is on line 16

describe('analyzeLeakHeuristically — return-value ownership (Juliet flow-variant 42)', () => {
  test('Source whose dispatcher never frees stays high-likelihood (recall preserved)', () => {
    const a = analyzeLeakHeuristically(bundleAt(3, 'badSource'), {}, RETURN_OWNERSHIP_SOURCE);
    expect(a.patternType).toBe('interprocedural_leak');
    expect(a.structuralLikelihood).toBe('high');
    expect(a.explanation).toContain('drops');
  });

  test('Source whose dispatcher frees the returned value is NOT a high-likelihood leak, and the explanation does not contradict itself', () => {
    const a = analyzeLeakHeuristically(bundleAt(16, 'goodB2GSource'), {}, RETURN_OWNERSHIP_SOURCE);
    expect(a.patternType).toBe('interprocedural_leak');
    expect(a.structuralLikelihood).toBe('low');
    // Regression guard for the cosmetic bug: explanation must not say "has no
    // matching free" when the caller demonstrably frees it.
    expect(a.explanation).not.toContain('no matching free');
    expect(a.explanation).toContain('frees');
  });

  test('a dispatcher-anchored return_ownership candidate (the synthesized sink shape) is scored correctly', () => {
    // Deliberately minimal — just the dispatcher and its allocating callee, no
    // sibling functions — so findAllocVar's ±3/+12-line search window (which
    // looks for a REAL alloc call near the candidate line, irrelevant for a
    // return_ownership candidate) can't accidentally collide with an unrelated
    // function's own allocation site, the way a denser multi-function fixture
    // could (a real Juliet case keeps these comfortably >12 lines apart).
    const source = `static char * badSource(void)
{
    char *data = (char *)calloc(100, sizeof(char));
    return data;
}

static void bad(void)
{
    char *data;
    data = badSource();
    ;
}
`; // the assignment `data = badSource();` is on line 10
    const bundle = {
      bundleId: 'b',
      candidate: {
        id: 'c',
        function_name: 'bad',
        file_path: '/virtual/test.c',
        line_number: 10,
        allocation_site: '/virtual/test.c:10:return_ownership:data',
        allocation_type: 'return_ownership',
        confidence: 'medium',
        context: '',
      },
      evidence: [],
      status: 'pending',
      createdAt: '',
      updatedAt: '',
    } as unknown as LeakBundle;
    const a = analyzeLeakHeuristically(bundle, {}, source);
    expect(a.variable).toBe('data');
    expect(a.structuralLikelihood).toBe('high');
  });
});

describe('analyzeLeakHeuristically — single-iteration loop (Juliet flow 16)', () => {
  test('good* variant that frees in a sibling loop is NOT a high-likelihood leak', () => {
    const a = analyzeLeakHeuristically(bundleAt(7, 'goodB2G'), {}, GOOD_LOOP);
    expect(a.freedAnywhereInFunction).toBe(true);
    expect(a.structuralLikelihood).toBe('low'); // regression guard for the 7 loop FPs
  });

  test('bad twin with no free anywhere stays high-likelihood (recall preserved)', () => {
    const a = analyzeLeakHeuristically(bundleAt(7, 'bad'), {}, BAD_LOOP);
    expect(a.freedAnywhereInFunction).toBe(false);
    expect(a.structuralLikelihood).toBe('high');
  });
});
