import { describe, expect, test } from 'bun:test';
import { ResultParserService } from './result-parser.service';

const svc = new ResultParserService();

// ── Valgrind --xml=yes ──────────────────────────────────────────────────────

const VALGRIND_XML = `<?xml version="1.0"?>
<valgrindoutput>
  <error>
    <unique>0x1</unique>
    <kind>Leak_DefinitelyLost</kind>
    <xwhat>
      <text>100 bytes in 1 blocks are definitely lost in loss record 1 of 2</text>
      <leakedbytes>100</leakedbytes>
      <leakedblocks>1</leakedblocks>
    </xwhat>
    <stack>
      <frame><ip>0xAAA</ip><fn>malloc</fn></frame>
      <frame><ip>0xBBB</ip><fn>make_buffer</fn><file>main.c</file><line>10</line></frame>
    </stack>
  </error>
  <error>
    <unique>0x2</unique>
    <kind>Leak_PossiblyLost</kind>
    <what>40 bytes possibly lost</what>
    <leak><bytes>40</bytes><blocks>2</blocks><kind>PossiblyLost</kind></leak>
    <stack>
      <frame><ip>0xCCC</ip><fn>calloc</fn></frame>
      <frame><ip>0xDDD</ip><fn>helper</fn><file>util.c</file><line>7</line></frame>
    </stack>
  </error>
</valgrindoutput>`;

describe('parseValgrindXmlString', () => {
  test('parses both errors with kind + message', () => {
    const f = svc.parseValgrindXmlString(VALGRIND_XML);
    expect(f.length).toBe(2);
    expect(f[0].kind).toBe('Leak_DefinitelyLost');
    expect(f[0].message).toBe('100 bytes in 1 blocks are definitely lost in loss record 1 of 2');
    expect(f[1].kind).toBe('Leak_PossiblyLost');
  });

  test('recovers leaked bytes/blocks from the flat <xwhat> variant', () => {
    const f = svc.parseValgrindXmlString(VALGRIND_XML);
    expect(f[0].aux.leak).toEqual({ bytes: 100, blocks: 1, kind: 'Leak_DefinitelyLost' });
  });

  test('recovers bytes/blocks/kind from the nested <leak> variant', () => {
    const f = svc.parseValgrindXmlString(VALGRIND_XML);
    expect(f[1].aux.leak).toEqual({ bytes: 40, blocks: 2, kind: 'PossiblyLost' });
  });

  test('parses the allocation stack (fn + file:line; libc frame has no file)', () => {
    const f = svc.parseValgrindXmlString(VALGRIND_XML);
    expect(f[0].stack).toEqual([
      { function: 'malloc', file: null, line: null },
      { function: 'make_buffer', file: 'main.c', line: 10 },
    ]);
  });

  test('empty / malformed input yields no findings (never throws)', () => {
    expect(svc.parseValgrindXmlString('')).toEqual([]);
    expect(svc.parseValgrindXmlString('<valgrindoutput></valgrindoutput>')).toEqual([]);
    expect(svc.parseValgrindXmlString('not xml at all')).toEqual([]);
  });

  test('an error with no leak block still parses (no aux.leak)', () => {
    const xml = `<error><kind>InvalidRead</kind><what>Invalid read of size 4</what>
      <stack><frame><fn>oops</fn><file>x.c</file><line>3</line></frame></stack></error>`;
    const f = svc.parseValgrindXmlString(xml);
    expect(f.length).toBe(1);
    expect(f[0].kind).toBe('InvalidRead');
    expect(f[0].message).toBe('Invalid read of size 4');
    expect(f[0].aux.leak).toBeUndefined();
  });
});

// ── ASan / LSan text output ─────────────────────────────────────────────────

const ASAN_OUTPUT = `=================================================================
==12345==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000010
    #0 0x4a1b2c in use_value /src/main.c:42
    #1 0x4a1d3e in main /src/main.c:50
SUMMARY: AddressSanitizer: heap-use-after-free`;

const LSAN_OUTPUT = `==99==ERROR: LeakSanitizer: detected memory leaks

Direct leak of 100 byte(s) in 1 object(s) allocated from:
    #0 0x55 in malloc
    #1 0x66 in make_buffer /src/buf.c:10

SUMMARY: AddressSanitizer: 100 byte(s) leaked in 1 allocation(s).`;

describe('parseAsanOutput / parseLsanOutput', () => {
  test('parses the ASan error kind + frames (file:line where present)', () => {
    const f = svc.parseAsanOutput(ASAN_OUTPUT);
    expect(f.length).toBe(1);
    expect(f[0].kind).toBe('heap-use-after-free on address 0x602000000010');
    expect(f[0].stack).toEqual([
      { function: 'use_value', file: '/src/main.c', line: 42 },
      { function: 'main', file: '/src/main.c', line: 50 },
    ]);
  });

  test('LSan leak: per-leak block → kind + bytes/blocks, frames (interceptor first)', () => {
    const f = svc.parseLsanOutput(LSAN_OUTPUT);
    expect(f.length).toBe(1);
    // Classified by Direct/Indirect (not the raw header text) so the judge gets a leak kind.
    expect(f[0].kind).toBe('definitely_lost');
    expect(f[0].aux.leak).toEqual({ bytes: 100, blocks: 1, kind: 'definitely_lost' });
    // The allocator interceptor frame (malloc, no file:line) is kept FIRST; the user site follows.
    expect(f[0].stack).toEqual([
      { function: 'malloc', file: null, line: null },
      { function: 'make_buffer', file: '/src/buf.c', line: 10 },
    ]);
  });

  test('two back-to-back ASan errors are split into two findings', () => {
    const two = `==1==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x1
    #0 0x1 in a /s/a.c:1
==1==ERROR: AddressSanitizer: stack-overflow on address 0x2
    #0 0x2 in b /s/b.c:2`;
    const f = svc.parseAsanOutput(two);
    expect(f.length).toBe(2);
    expect(f[0].kind).toContain('heap-buffer-overflow');
    expect(f[1].kind).toContain('stack-overflow');
    expect(f[1].stack[0]).toEqual({ function: 'b', file: '/s/b.c', line: 2 });
  });

  test('output with no sanitizer error yields no findings', () => {
    expect(svc.parseAsanOutput('all good, exit 0')).toEqual([]);
    expect(svc.parseAsanOutput('')).toEqual([]);
  });
});
