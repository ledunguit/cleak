import { describe, expect, test } from 'vitest';
import { CandidateScanService, enclosingFunctionName } from '../../src/services/candidate-scan.service';
import { CParserService } from '../../src/services/c-parser.service';

const svc = new CandidateScanService(new CParserService());
const allocLines = async (src: string): Promise<number[]> =>
  (await svc.scan('t.c', src)).candidates.map((c: any) => c.lineNumber);
const allocLinesWith = async (src: string, allocs?: string[], deallocs?: string[]): Promise<number[]> =>
  (await svc.scan('t.c', src, allocs, deallocs)).candidates.map((c: any) => c.lineNumber);

describe('CandidateScanService — allocator-aware discovery', () => {
  test('discovers libc allocators (malloc/calloc/realloc/strdup)', async () => {
    const src = ['a = malloc(8);', 'b = calloc(1, 8);', 'c = realloc(p, 8);', 'd = strdup(s);'].join('\n');
    expect(await allocLines(src)).toEqual([1, 2, 3, 4]);
  });

  test('discovers CUSTOM allocators named alloc… / …_alloc… (real-project leaks)', async () => {
    const src = [
      'p = global_hooks.allocate(n);', // line 1 — cJSON-style indirect allocator
      'q = pool_alloc(sz);', // line 2 — snake_case wrapper
      'r = my_allocator(sz);', // line 3
    ].join('\n');
    expect(await allocLines(src)).toEqual([1, 2, 3]);
  });

  test('prefixed libc wrappers via EXACT names (a greedy `_calloc` pattern would over-match)', async () => {
    // cJSON_malloc / g_realloc carry no malloc/alloc token at a word boundary; supply
    // them as exact per-project names (≈ LAMeD AllocSource) — precise, no over-match.
    const src = ['p = (char*)cJSON_malloc(len);', 'q = g_realloc(p, n);', 'r = apr_strdup(pool, s);'].join('\n');
    expect(await allocLinesWith(src, ['cJSON_malloc', 'g_realloc', 'apr_strdup'])).toEqual([1, 2, 3]);
    // WITHOUT the names, NO greedy wrapper fires (removing that over-match is the fix).
    expect(await allocLines(src)).toEqual([]);
  });

  test('REGRESSION: a function NAME containing _calloc/_malloc is NOT an allocation', async () => {
    // Juliet defines `char *char_calloc_01_bad(void)`. The old greedy wrapper matched
    // the function name as an allocation → FP explosion (Juliet FP 7→44). Must ignore it.
    const src = ['static char * char_calloc_01_bad(void)', '{', '  data = calloc(1, 8);', '}'].join('\n');
    expect(await allocLines(src)).toEqual([3]); // only the real calloc() on line 3
  });

  test('does NOT mistake deallocators for allocations (precise word boundary)', async () => {
    // "deallocate"/"dealloc"/"free"/custom *_free must NOT be discovered as
    // allocation sites — the wrapper patterns require _malloc/_calloc/_realloc/_strdup.
    const src = ['global_hooks.deallocate(p);', 'pool_dealloc(p);', 'free(p);', 'cJSON_free(p);', 'g_free(p);'].join('\n');
    expect(await allocLines(src)).toEqual([]);
  });

  test('xalloc wrappers still discovered; "freeze(" is not a free-shaped false match', async () => {
    expect(await allocLines('a = xmalloc(8);')).toEqual([1]);
    // sanity: an alloc whose pointer is later "freeze()"d is still discovered
    expect(await allocLines('p = malloc(8);\nfreeze(p);')).toEqual([1]);
  });

  test('discovers project FACTORY allocators from EXTRA_ALLOCATOR_NAMES (LAMeD-style)', async () => {
    // Running on the real LAMeD cjson corpus showed the leaks are factory allocs
    // (cJSON_Duplicate / cJSON_CreateObject) whose names carry NO malloc/alloc token,
    // so nothing discovers them. A per-project allocator list (≈ LAMeD AllocSource)
    // makes the leak site discoverable.
    const prev = process.env.EXTRA_ALLOCATOR_NAMES;
    process.env.EXTRA_ALLOCATOR_NAMES = 'cJSON_Duplicate, cJSON_CreateObject ,cJSON_New_Item';
    try {
      const src = [
        'v = cJSON_Duplicate(x, 1);', // 1 — factory alloc
        'o = cJSON_CreateObject();', // 2
        'n = cJSON_New_Item(&hooks);', // 3
        'p = cJSON_Print(o);', // 4 — NOT listed → not discovered
      ].join('\n');
      expect(await allocLines(src)).toEqual([1, 2, 3]);
    } finally {
      if (prev === undefined) delete process.env.EXTRA_ALLOCATOR_NAMES;
      else process.env.EXTRA_ALLOCATOR_NAMES = prev;
    }
  });

  test('EXTRA_ALLOCATOR_NAMES ignores unsafe / empty entries', async () => {
    const prev = process.env.EXTRA_ALLOCATOR_NAMES;
    process.env.EXTRA_ALLOCATOR_NAMES = ' , bad-name(, make_thing';
    try {
      // `make_thing` has no alloc token → only the EXTRA list can discover it;
      // `bad-name(` is not a safe identifier → ignored (no regex injection).
      expect(await allocLines('a = make_thing(8);\nb = other_call();')).toEqual([1]);
    } finally {
      if (prev === undefined) delete process.env.EXTRA_ALLOCATOR_NAMES;
      else process.env.EXTRA_ALLOCATOR_NAMES = prev;
    }
  });

  test('per-scan allocators param (manifest-supplied) discovers factory allocators', async () => {
    // The clean mechanism: the corpus manifest supplies the project allocator API,
    // threaded as a param (no env). cJSON_Print is NOT an owning allocator → skipped.
    const src = ['v = cJSON_Duplicate(x, 1);', 'o = cJSON_CreateObject();', 'p = cJSON_Print(o);'].join('\n');
    expect(await allocLinesWith(src, ['cJSON_Duplicate', 'cJSON_CreateObject'])).toEqual([1, 2]);
  });

  test('manifest allocators take PRECEDENCE over the env var', async () => {
    const prev = process.env.EXTRA_ALLOCATOR_NAMES;
    // Names with NO malloc/alloc token, so only the EXTRA list (param or env) finds them.
    process.env.EXTRA_ALLOCATOR_NAMES = 'env_factory';
    try {
      // Param present → env ignored: only the param name is discovered (line 2).
      const src = 'a = env_factory(8);\nb = param_factory(8);';
      expect(await allocLinesWith(src, ['param_factory'])).toEqual([2]);
    } finally {
      if (prev === undefined) delete process.env.EXTRA_ALLOCATOR_NAMES;
      else process.env.EXTRA_ALLOCATOR_NAMES = prev;
    }
  });

  test('custom deallocators param: a custom free is counted (so it is not mistaken for a leak)', async () => {
    // `my_release` has no free/delete token → without the param it is NOT a free.
    const withParam = await svc.scan('t.c', 'p = malloc(8);\nmy_release(p);', undefined, ['my_release']);
    const without = await svc.scan('t.c', 'p = malloc(8);\nmy_release(p);');
    expect(withParam.candidates[0].observedDeallocationCount).toBe(1);
    expect(without.candidates[0].observedDeallocationCount).toBe(0);
  });

  test('combined free matcher preserves the exact case-insensitive `\\w*free(` group: FREE( counts as a dealloc', async () => {
    // Guard for the precompiled-union refactor: `FREE(` was ALREADY a free before the
    // change (the case-insensitive `\w*free\s*\(` group subsumes it) — the combined
    // matcher must not lose that group.
    const r = await svc.scan('t.c', 'p = malloc(8);\nFREE(p);');
    expect(r.candidates[0].observedDeallocationCount).toBe(1);
  });

  test('combined free matcher keeps exact-name deallocators case-sensitive (my_release vs MY_RELEASE)', async () => {
    // namePatterns() builds `\bNAME\s*\(` WITHOUT the i flag; the union splitter keeps
    // those in the case-sensitive group, so an all-caps call is not a free.
    const lower = await svc.scan('t.c', 'p = malloc(8);\nmy_release(p);', undefined, ['my_release']);
    const upper = await svc.scan('t.c', 'p = malloc(8);\nMY_RELEASE(p);', undefined, ['my_release']);
    expect(lower.candidates[0].observedDeallocationCount).toBe(1);
    expect(upper.candidates[0].observedDeallocationCount).toBe(0);
  });

  test('combined free matcher still counts custom *_free / *_delete deallocators (case-insensitive group)', async () => {
    const r = await svc.scan('t.c', 'p = malloc(8);\ncJSON_free(p);\ncJSON_Delete(p);');
    expect(r.candidates[0].observedDeallocationCount).toBe(2);
  });

  test('alloc fast-reject preserves first-pattern-in-order winning semantics on multi-allocator lines', async () => {
    // A built-in allocator pattern (calloc) appears LATER in the line than a project
    // factory allocator; the OLD per-pattern scan reported the pattern-order winner
    // (calloc), and the fast-reject refactor must not switch to leftmost-position.
    const r = await svc.scan('t.c', 'p = cJSON_Duplicate(x); q = calloc(1, 8);', ['cJSON_Duplicate']);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].lineNumber).toBe(1);
    expect(r.candidates[0].allocationType).toBe('calloc');
  });
});

// Function attribution range-picker (the engine of F1). Tree-sitter only loads in the
// Linux container, so the end-to-end "alloc 30 lines in → correct function" path is
// verified there; here we unit-test the pure range logic with synthetic ranges.
describe('enclosingFunctionName — innermost-range attribution', () => {
  const fns = [
    { functionName: 'first', lineNumber: 1, endLine: 3 },
    { functionName: 'big', lineNumber: 5, endLine: 90 }, // a 30+-line body — the old 20-line backscan failed here
    { functionName: 'outer', lineNumber: 100, endLine: 200 },
    { functionName: 'inner', lineNumber: 120, endLine: 140 }, // nested inside outer
  ];

  test('a line deep inside a large function attributes to that function (not unknown)', () => {
    expect(enclosingFunctionName(60, fns)).toBe('big'); // 55 lines past the signature
  });
  test('innermost (smallest) range wins on nesting', () => {
    expect(enclosingFunctionName(130, fns)).toBe('inner');
    expect(enclosingFunctionName(110, fns)).toBe('outer'); // outside inner → outer
  });
  test('range bounds are inclusive', () => {
    expect(enclosingFunctionName(5, fns)).toBe('big');
    expect(enclosingFunctionName(90, fns)).toBe('big');
  });
  test('a line in no function returns null (caller falls back to the lexical scan)', () => {
    expect(enclosingFunctionName(4, fns)).toBeNull(); // gap between first and big
    expect(enclosingFunctionName(999, fns)).toBeNull();
  });
});
