import { describe, expect, test } from 'bun:test';
import { reduce, keyToIntent, type EditState, type InputKey } from './lineEdit';

const st = (value: string, cursor: number): EditState => ({ value, cursor });

describe('reduce — cursor motion', () => {
  test('left/right clamp at the bounds', () => {
    expect(reduce(st('abc', 0), { type: 'left' }).cursor).toBe(0);
    expect(reduce(st('abc', 3), { type: 'right' }).cursor).toBe(3);
    expect(reduce(st('abc', 1), { type: 'left' }).cursor).toBe(0);
    expect(reduce(st('abc', 1), { type: 'right' }).cursor).toBe(2);
  });

  test('home/end jump to the line edges', () => {
    expect(reduce(st('hello', 2), { type: 'home' }).cursor).toBe(0);
    expect(reduce(st('hello', 2), { type: 'end' }).cursor).toBe(5);
  });

  test('wordLeft/wordRight stop on whitespace boundaries', () => {
    expect(reduce(st('foo bar baz', 11), { type: 'wordLeft' }).cursor).toBe(8); // → start of "baz"
    expect(reduce(st('foo bar baz', 8), { type: 'wordLeft' }).cursor).toBe(4); // → start of "bar"
    expect(reduce(st('foo bar baz', 0), { type: 'wordRight' }).cursor).toBe(3); // → end of "foo"
    expect(reduce(st('foo bar baz', 3), { type: 'wordRight' }).cursor).toBe(7); // skip space, end of "bar"
  });
});

describe('reduce — editing', () => {
  test('insert puts text at the cursor and advances it', () => {
    const r = reduce(st('ac', 1), { type: 'insert', text: 'b' });
    expect(r).toEqual({ value: 'abc', cursor: 2 });
  });

  test('deleteBack removes the char before the cursor; no-op at column 0', () => {
    expect(reduce(st('abc', 2), { type: 'deleteBack' })).toEqual({ value: 'ac', cursor: 1 });
    expect(reduce(st('abc', 0), { type: 'deleteBack' })).toEqual({ value: 'abc', cursor: 0 });
  });

  test('deleteWordBack deletes back to the previous word boundary', () => {
    // "foo bar|" → "foo |"
    expect(reduce(st('foo bar', 7), { type: 'deleteWordBack' })).toEqual({ value: 'foo ', cursor: 4 });
    // mid-word: "foo ba|z" → "foo |z"
    expect(reduce(st('foo baz', 6), { type: 'deleteWordBack' })).toEqual({ value: 'foo z', cursor: 4 });
  });

  test('killToStart / killToEnd cut the rest of the line', () => {
    expect(reduce(st('hello world', 6), { type: 'killToStart' })).toEqual({ value: 'world', cursor: 0 });
    expect(reduce(st('hello world', 5), { type: 'killToEnd' })).toEqual({ value: 'hello', cursor: 5 });
  });
});

describe('keyToIntent — Ink key → intent', () => {
  const k = (over: Partial<InputKey>): InputKey => over;

  test('printable text inserts (space included)', () => {
    expect(keyToIntent('a', k({}))).toEqual({ type: 'insert', text: 'a' });
    expect(keyToIntent(' ', k({}))).toEqual({ type: 'insert', text: ' ' });
  });

  test('Ctrl combos map to the readline edits', () => {
    expect(keyToIntent('a', k({ ctrl: true }))).toEqual({ type: 'home' });
    expect(keyToIntent('e', k({ ctrl: true }))).toEqual({ type: 'end' });
    expect(keyToIntent('u', k({ ctrl: true }))).toEqual({ type: 'killToStart' });
    expect(keyToIntent('k', k({ ctrl: true }))).toEqual({ type: 'killToEnd' });
    expect(keyToIntent('w', k({ ctrl: true }))).toEqual({ type: 'deleteWordBack' });
  });

  test('plain Backspace vs Option+Backspace (delete + meta)', () => {
    expect(keyToIntent('', k({ delete: true }))).toEqual({ type: 'deleteBack' });
    expect(keyToIntent('', k({ delete: true, meta: true }))).toEqual({ type: 'deleteWordBack' });
    expect(keyToIntent('', k({ backspace: true }))).toEqual({ type: 'deleteBack' });
  });

  test('arrows: plain moves one, Option (meta) moves a word', () => {
    expect(keyToIntent('', k({ leftArrow: true }))).toEqual({ type: 'left' });
    expect(keyToIntent('', k({ rightArrow: true }))).toEqual({ type: 'right' });
    expect(keyToIntent('', k({ leftArrow: true, meta: true }))).toEqual({ type: 'wordLeft' });
    expect(keyToIntent('', k({ rightArrow: true, meta: true }))).toEqual({ type: 'wordRight' });
  });

  test('keys reserved for App fall through (null): ↑/↓, Tab, Enter, Esc, Ctrl+C', () => {
    expect(keyToIntent('', k({ upArrow: true }))).toBeNull();
    expect(keyToIntent('', k({ downArrow: true }))).toBeNull();
    expect(keyToIntent('', k({ tab: true }))).toBeNull();
    expect(keyToIntent('', k({ tab: true, shift: true }))).toBeNull();
    expect(keyToIntent('', k({ return: true }))).toBeNull();
    expect(keyToIntent('', k({ escape: true }))).toBeNull();
    expect(keyToIntent('c', k({ ctrl: true }))).toBeNull();
  });
});
