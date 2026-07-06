import { describe, expect, test } from 'bun:test';
import { analyzeLeakHeuristically } from '../../src/analysis/heuristic-leak-analysis';
import type { LeakBundle } from '../../src/types';

/** Minimal bundle whose candidate points at `line` (1-based) of the source under test. */
function bundleAt(line: number, fn: string): LeakBundle {
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
