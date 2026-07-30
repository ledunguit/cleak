import { describe, expect, test } from 'bun:test';
import { _internal } from '../../src/domain/allocatorVerification';

const { synthesizeArg, buildAllocatorHarnessSource, buildDeallocatorHarnessSource, classifyAllocatorRun, classifyDeallocatorRun, isPointerReturn } =
  _internal;

describe('synthesizeArg', () => {
  test('char pointer gets a short string literal', () => {
    expect(synthesizeArg({ name: 'name', type: 'char *', isPointer: true })).toBe('"x"');
  });
  test('other pointers get NULL', () => {
    expect(synthesizeArg({ name: 'ctx', type: 'void *', isPointer: true })).toBe('NULL');
  });
  test('size-like integer names get a small positive constant', () => {
    expect(synthesizeArg({ name: 'size', type: 'size_t', isPointer: false })).toBe('8');
    expect(synthesizeArg({ name: 'n', type: 'int', isPointer: false })).toBe('8');
    expect(synthesizeArg({ name: 'count', type: 'unsigned', isPointer: false })).toBe('8');
  });
  test('other integers default to 1', () => {
    expect(synthesizeArg({ name: 'flag', type: 'int', isPointer: false })).toBe('1');
  });
});

describe('isPointerReturn', () => {
  test('detects pointer return types', () => {
    expect(isPointerReturn('char *')).toBe(true);
    expect(isPointerReturn('void *')).toBe(true);
    expect(isPointerReturn('int')).toBe(false);
    expect(isPointerReturn('')).toBe(false);
  });
});

describe('buildAllocatorHarnessSource', () => {
  test('static linkage #includes the defining file, does not extern-declare', () => {
    const src = buildAllocatorHarnessSource(
      'pool_alloc',
      { filePath: '/repo/pool.c', returnType: 'void *', isStaticLinkage: true, parameters: [{ name: 'n', type: 'size_t', isPointer: false }] },
      '/analyzer/pool.c',
    );
    expect(src).toContain('#include "/analyzer/pool.c"');
    expect(src).not.toContain('extern');
    expect(src).toContain('pool_alloc(8)');
    expect(src).toContain('int main(void)');
  });

  test('external linkage extern-declares with matching param types', () => {
    const src = buildAllocatorHarnessSource(
      'cJSON_Duplicate',
      {
        filePath: '/repo/cJSON.c',
        returnType: 'cJSON *',
        isStaticLinkage: false,
        parameters: [
          { name: 'item', type: 'cJSON *', isPointer: true },
          { name: 'recurse', type: 'int', isPointer: false },
        ],
      },
      '/analyzer/cJSON.c',
    );
    expect(src).toContain('extern cJSON * cJSON_Duplicate(cJSON *, int);');
    expect(src).toContain('#include <stddef.h>'); // standard preamble — resolves size_t/NULL in extern decls
    expect(src).not.toContain('#include "'); // no #include of the TARGET file (external linkage doesn't need it)
    expect(src).toContain('cJSON_Duplicate(NULL, 1)');
  });
});

describe('buildDeallocatorHarnessSource', () => {
  test('pairs an allocator call with the deallocator call, casting to the deallocator param type', () => {
    const allocSig = { filePath: '/repo/pool.c', returnType: 'void *', isStaticLinkage: false, parameters: [{ name: 'n', type: 'size_t', isPointer: false }] };
    const deallocSig = { filePath: '/repo/pool.c', returnType: 'void', isStaticLinkage: false, parameters: [{ name: 'p', type: 'void *', isPointer: true }] };
    const src = buildDeallocatorHarnessSource('pool_free', deallocSig, '/analyzer/pool.c', 'pool_alloc', allocSig, '/analyzer/pool.c');
    expect(src).toContain('pool_alloc(8)');
    expect(src).toContain('pool_free((void *)p)');
  });

  test('does not #include the same file twice when both functions are static in it', () => {
    const allocSig = { filePath: '/repo/pool.c', returnType: 'void *', isStaticLinkage: true, parameters: [] };
    const deallocSig = { filePath: '/repo/pool.c', returnType: 'void', isStaticLinkage: true, parameters: [{ name: 'p', type: 'void *', isPointer: true }] };
    const src = buildDeallocatorHarnessSource('pool_free', deallocSig, '/analyzer/pool.c', 'pool_alloc', allocSig, '/analyzer/pool.c');
    expect(src.match(/#include "\/analyzer\/pool\.c"/g)?.length).toBe(1);
  });
});

const finding = (kind: string) => ({ kind });

describe('classifyAllocatorRun', () => {
  test('build/run failure → unverified', () => {
    expect(classifyAllocatorRun(false, [])).toBe('unverified');
  });
  test('SEGV/overflow/abort → unverified (bad synthesized args, not evidence)', () => {
    expect(classifyAllocatorRun(true, [finding('SEGV on unknown address')])).toBe('unverified');
    expect(classifyAllocatorRun(true, [finding('heap-buffer-overflow')])).toBe('unverified');
  });
  test('a leak finding → confirmed (we deliberately never freed)', () => {
    expect(classifyAllocatorRun(true, [finding('detected memory leaks')])).toBe('confirmed');
  });
  test('clean run, no leak → refuted (not a heap allocator)', () => {
    expect(classifyAllocatorRun(true, [])).toBe('refuted');
  });
});

describe('classifyDeallocatorRun', () => {
  test('build/run failure → unverified', () => {
    expect(classifyDeallocatorRun(false, [])).toBe('unverified');
  });
  test('clean run (paired alloc+free, no leak, no invalid-free) → confirmed', () => {
    expect(classifyDeallocatorRun(true, [])).toBe('confirmed');
  });
  test('ANY finding, including invalid-free → unverified, NEVER refuted', () => {
    expect(classifyDeallocatorRun(true, [finding('attempting double-free')])).toBe('unverified');
    expect(classifyDeallocatorRun(true, [finding('detected memory leaks')])).toBe('unverified');
  });
});
