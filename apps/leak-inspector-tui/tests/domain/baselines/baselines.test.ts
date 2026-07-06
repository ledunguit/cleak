import { describe, expect, test } from 'bun:test';
import { parseClangLeaks } from '../../../src/domain/baselines/clangAnalyzer';
import { parseInferLeaks } from '../../../src/domain/baselines/infer';

describe('parseClangLeaks', () => {
  // Real `clang --analyze -analyzer-output=text` output (Juliet calloc_42): a true
  // leak warning + its alloc note, plus noise (deadcode, stack-escape) to filter.
  const CLANG_42 = [
    "case42.c:39:5: warning: Value stored to 'data' is never read [deadcode.DeadStores]",
    "case42.c:42:1: warning: Potential leak of memory pointed to by 'data' [unix.Malloc]",
    'case42.c:27:20: note: Memory is allocated',
    "case42.c:30:5: note: Taking false branch",
    'case42.c:56:5: warning: Address of stack memory allocated by call to alloca() on line 52 returned to caller [core.StackAddressEscape]',
    "case42.c:63:5: warning: Value stored to 'data' is never read [deadcode.DeadStores]",
    '5 warnings generated.',
  ].join('\n');

  test('keeps only the leak warning and pairs it with the allocation note', () => {
    const found = parseClangLeaks(CLANG_42);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: 'case42.c', line: 42, allocLine: 27, checker: 'unix.Malloc' });
  });

  test('filters out deadcode, stack-escape, and "should not be deallocated" (double-free)', () => {
    const out = parseClangLeaks(
      [
        "x.c:53:9: warning: Memory allocated by 'alloca()' should not be deallocated [unix.Malloc]",
        'x.c:10:1: warning: Dereference of null pointer [core.NullDereference]',
        "x.c:20:5: warning: Value stored to 'p' is never read [deadcode.DeadStores]",
      ].join('\n'),
    );
    expect(out).toHaveLength(0);
  });

  test('a leak warning without an alloc note still parses (allocLine undefined)', () => {
    const out = parseClangLeaks("y.c:36:1: warning: Potential leak of memory pointed to by 'data' [unix.Malloc]");
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(36);
    expect(out[0].allocLine).toBeUndefined();
  });

  test('cplusplus.NewDelete leaks are kept', () => {
    const out = parseClangLeaks('z.cpp:12:3: warning: Potential leak of memory pointed to by \'obj\' [cplusplus.NewDelete]');
    expect(out).toHaveLength(1);
    expect(out[0].checker).toBe('cplusplus.NewDelete');
  });
});

describe('parseInferLeaks', () => {
  test('keeps memory-leak bug types and maps procedure/file/line', () => {
    const report = [
      { bug_type: 'MEMORY_LEAK_C', file: 'src/a.c', line: 42, procedure: 'bad' },
      { bug_type: 'NULL_DEREFERENCE', file: 'src/a.c', line: 10, procedure: 'good' },
      { bug_type: 'PULSE_MEMORY_LEAK_C', file: 'src/b.c', line: 7, procedure: 'helper' },
    ];
    const out = parseInferLeaks(report);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ function: 'bad', file: 'a.c', line: 42, verdict: 'confirmed_leak', verdict_tool: 'infer' });
    expect(out[1].function).toBe('helper');
  });

  test('non-array / empty input → []', () => {
    expect(parseInferLeaks(null)).toEqual([]);
    expect(parseInferLeaks([])).toEqual([]);
  });
});
