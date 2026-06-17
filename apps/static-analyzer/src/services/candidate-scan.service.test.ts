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

  test('does NOT mistake deallocators for allocations (precise word boundary)', () => {
    // "deallocate"/"dealloc"/"free" must NOT be discovered as allocation sites —
    // the "alloc" in "deallocate" is mid-word, so \balloc does not match it.
    const src = ['global_hooks.deallocate(p);', 'pool_dealloc(p);', 'free(p);', 'cJSON_free(p);'].join('\n');
    expect(allocLines(src)).toEqual([]);
  });

  test('xalloc wrappers still discovered; "freeze(" is not a free-shaped false match', () => {
    expect(allocLines('a = xmalloc(8);')).toEqual([1]);
    // sanity: an alloc whose pointer is later "freeze()"d is still discovered
    expect(allocLines('p = malloc(8);\nfreeze(p);')).toEqual([1]);
  });
});
