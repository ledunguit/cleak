import { describe, expect, test } from 'vitest';
import { splitCommandLine, extractReusableFlags } from '../../src/services/compile-commands.service';

describe('splitCommandLine', () => {
  test('splits a plain compiler invocation', () => {
    expect(splitCommandLine('gcc -c foo.c -o foo.o')).toEqual(['gcc', '-c', 'foo.c', '-o', 'foo.o']);
  });

  test('honors double-quoted args with embedded spaces', () => {
    expect(splitCommandLine('gcc -DGREETING="hello world" foo.c')).toEqual(['gcc', '-DGREETING=hello world', 'foo.c']);
  });

  test('honors single-quoted args', () => {
    expect(splitCommandLine("gcc -DGREETING='hi there' foo.c")).toEqual(['gcc', '-DGREETING=hi there', 'foo.c']);
  });
});

describe('extractReusableFlags', () => {
  test('keeps -I/-D/-std, drops -o/-c/positional source args and the compiler itself', () => {
    const args = ['clang', '-Iinclude', '-DFOO=1', '-std=c11', '-c', 'foo.c', '-o', 'foo.o'];
    expect(extractReusableFlags(args)).toEqual(['-Iinclude', '-DFOO=1', '-std=c11']);
  });

  test('drops -fsanitize=* (the harness build picks its own)', () => {
    const args = ['clang', '-fsanitize=address', '-Iinclude', 'foo.c'];
    expect(extractReusableFlags(args)).toEqual(['-Iinclude']);
  });

  test('drops -Werror but keeps other flags', () => {
    const args = ['gcc', '-Werror', '-DX', 'foo.c'];
    expect(extractReusableFlags(args)).toEqual(['-DX']);
  });

  test('empty/compiler-only argv yields no flags', () => {
    expect(extractReusableFlags(['clang'])).toEqual([]);
  });

  test('BLOCKLIST: flags not previously on the allowlist now survive (-pthread, --target=, -fpack-struct, -Wall)', () => {
    const args = ['clang', '-pthread', '--target=x86_64-linux-gnu', '-fpack-struct=1', '-Wall', '-Iinclude', 'foo.c'];
    expect(extractReusableFlags(args)).toEqual(['-pthread', '--target=x86_64-linux-gnu', '-fpack-struct=1', '-Wall', '-Iinclude']);
  });

  test('drops dependency-file flags (-MD -MF foo.d, joined -MFfoo.d, -MT/-MQ + value)', () => {
    expect(extractReusableFlags(['gcc', '-MD', '-MF', 'build/foo.d', '-DX', 'foo.c'])).toEqual(['-DX']);
    expect(extractReusableFlags(['gcc', '-MMD', '-MP', '-MFfoo.d', '-DX', 'foo.c'])).toEqual(['-DX']);
    expect(extractReusableFlags(['gcc', '-MT', 'foo.o', '-MQ', 'foo', '-DX', 'foo.c'])).toEqual(['-DX']);
  });

  test('drops positional .cpp/.cc source args too, not just .c', () => {
    expect(extractReusableFlags(['clang++', '-Iinclude', 'foo.cpp', 'bar.cc'])).toEqual(['-Iinclude']);
  });
});
