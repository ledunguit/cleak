import { describe, expect, test } from 'bun:test';
import { CandidateScanService } from './candidate-scan.service';

const svc = new CandidateScanService();
const allocLines = (src: string): number[] =>
  svc.scan('t.c', src).candidates.map((c: any) => c.lineNumber);

describe('CandidateScanService — allocator-aware discovery', () => {
  test('discovers libc allocators (malloc/calloc/realloc/strdup)', () => {
    const src = ['a = malloc(8);', 'b = calloc(1, 8);', 'c = realloc(p, 8);', 'd = strdup(s);'].join('\n');
    expect(allocLines(src)).toEqual([1, 2, 3, 4]);
  });

  test('discovers CUSTOM allocators named alloc… / …_alloc… (real-project leaks)', () => {
    const src = [
      'p = global_hooks.allocate(n);', // line 1 — cJSON-style indirect allocator
      'q = pool_alloc(sz);', // line 2 — snake_case wrapper
      'r = my_allocator(sz);', // line 3
    ].join('\n');
    expect(allocLines(src)).toEqual([1, 2, 3]);
  });

  test('discovers prefixed libc WRAPPERS: cJSON_malloc / g_realloc / apr_strdup', () => {
    // The real cJSON leaks flow through `cJSON_malloc` — `_malloc` is not `_alloc`,
    // and the `_` before `malloc` removes the \b boundary, so the older patterns
    // missed it entirely (→ 0 candidates in the flaw function → 0 recall on LAMeD).
    const src = [
      'p = (char*)cJSON_malloc(len);', // line 1
      'q = g_realloc(p, n);', // line 2
      'r = apr_strdup(pool, s);', // line 3
      'd = my_calloc(1, n);', // line 4
    ].join('\n');
    expect(allocLines(src)).toEqual([1, 2, 3, 4]);
  });

  test('does NOT mistake deallocators for allocations (precise word boundary)', () => {
    // "deallocate"/"dealloc"/"free"/custom *_free must NOT be discovered as
    // allocation sites — the wrapper patterns require _malloc/_calloc/_realloc/_strdup.
    const src = ['global_hooks.deallocate(p);', 'pool_dealloc(p);', 'free(p);', 'cJSON_free(p);', 'g_free(p);'].join('\n');
    expect(allocLines(src)).toEqual([]);
  });

  test('xalloc wrappers still discovered; "freeze(" is not a free-shaped false match', () => {
    expect(allocLines('a = xmalloc(8);')).toEqual([1]);
    // sanity: an alloc whose pointer is later "freeze()"d is still discovered
    expect(allocLines('p = malloc(8);\nfreeze(p);')).toEqual([1]);
  });

  test('discovers project FACTORY allocators from EXTRA_ALLOCATOR_NAMES (LAMeD-style)', () => {
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
      expect(allocLines(src)).toEqual([1, 2, 3]);
    } finally {
      if (prev === undefined) delete process.env.EXTRA_ALLOCATOR_NAMES;
      else process.env.EXTRA_ALLOCATOR_NAMES = prev;
    }
  });

  test('EXTRA_ALLOCATOR_NAMES ignores unsafe / empty entries', () => {
    const prev = process.env.EXTRA_ALLOCATOR_NAMES;
    process.env.EXTRA_ALLOCATOR_NAMES = ' , bad-name(, make_thing';
    try {
      // `make_thing` has no alloc token → only the EXTRA list can discover it;
      // `bad-name(` is not a safe identifier → ignored (no regex injection).
      expect(allocLines('a = make_thing(8);\nb = other_call();')).toEqual([1]);
    } finally {
      if (prev === undefined) delete process.env.EXTRA_ALLOCATOR_NAMES;
      else process.env.EXTRA_ALLOCATOR_NAMES = prev;
    }
  });
});
