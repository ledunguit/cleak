import { describe, expect, test } from 'vitest';
import { CParserService } from '../../src/services/c-parser.service';

const svc = new CParserService();
const parseOne = (src: string, name: string) => svc.parse(src, 't.c').functions.find((f) => f.functionName === name);

describe('CParserService — signature/linkage extraction (Stage B2 harness synthesis needs these)', () => {
  test('static function → storageClass "static", pointer return type, pointer params', () => {
    const src = `
static char *build_buffer(const char *name, int shout) {
    char *buf = (char *)malloc(64);
    return buf;
}
`;
    const fn = parseOne(src, 'build_buffer');
    expect(fn?.storageClass).toBe('static');
    expect(fn?.returnType).toBe('char *');
    expect(fn?.parameters).toEqual([
      { name: 'name', type: 'char *', isPointer: true },
      { name: 'shout', type: 'int', isPointer: false },
    ]);
  });

  test('non-static (externally linked) function → storageClass "none"', () => {
    const src = `
char *make_greeting(const char *name, int shout) {
    return name;
}
`;
    const fn = parseOne(src, 'make_greeting');
    expect(fn?.storageClass).toBe('none');
    expect(fn?.returnType).toBe('char *');
  });

  test('extern function → storageClass "extern"', () => {
    const src = `
extern int compute_total(int a, int b) {
    return a + b;
}
`;
    const fn = parseOne(src, 'compute_total');
    expect(fn?.storageClass).toBe('extern');
    expect(fn?.returnType).toBe('int');
    expect(fn?.parameters).toEqual([
      { name: 'a', type: 'int', isPointer: false },
      { name: 'b', type: 'int', isPointer: false },
    ]);
  });

  test('non-pointer return type has no trailing " *"', () => {
    const src = `int add(int a, int b) { return a + b; }`;
    expect(parseOne(src, 'add')?.returnType).toBe('int');
  });
});
