import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHistory, appendHistory, historyStep, MAX_HISTORY } from './history';

// Redirect the history file into a temp XDG dir so we never touch the real one.
let dir: string;
const prevXdg = process.env.XDG_CONFIG_HOME;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'history-test-'));
  process.env.XDG_CONFIG_HOME = dir;
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe('appendHistory + loadHistory (disk round-trip)', () => {
  test('persists entries and reloads them oldest→newest', () => {
    let h: string[] = [];
    h = appendHistory(h, '/scan a');
    h = appendHistory(h, '/scan b');
    expect(h).toEqual(['/scan a', '/scan b']);
    expect(loadHistory()).toEqual(['/scan a', '/scan b']);
  });

  test('skips blanks and consecutive duplicates', () => {
    let h: string[] = ['/mode'];
    h = appendHistory(h, '   '); // blank
    h = appendHistory(h, '/mode'); // dup of last
    expect(h).toEqual(['/mode']);
    h = appendHistory(h, '/dynamic');
    h = appendHistory(h, '/mode'); // not consecutive → kept
    expect(h).toEqual(['/mode', '/dynamic', '/mode']);
  });

  test('caps the list at MAX_HISTORY', () => {
    let h: string[] = [];
    for (let i = 0; i < MAX_HISTORY + 50; i++) h = appendHistory(h, `cmd ${i}`);
    expect(h.length).toBe(MAX_HISTORY);
    expect(h[h.length - 1]).toBe(`cmd ${MAX_HISTORY + 49}`);
  });
});

describe('historyStep — ↑/↓ navigation', () => {
  const entries = ['one', 'two', 'three']; // newest is "three"

  test('↑ from the draft recalls newest, then steps to older, clamped', () => {
    let r = historyStep(entries, -1, 'draft', 'prev');
    expect(r).toEqual({ index: 2, value: 'three' });
    r = historyStep(entries, 2, 'draft', 'prev');
    expect(r).toEqual({ index: 1, value: 'two' });
    r = historyStep(entries, 0, 'draft', 'prev'); // already oldest
    expect(r).toEqual({ index: 0, value: 'one' });
  });

  test('↓ steps toward newer and restores the draft past the newest', () => {
    let r = historyStep(entries, 0, 'draft', 'next');
    expect(r).toEqual({ index: 1, value: 'two' });
    r = historyStep(entries, 2, 'draft', 'next'); // past newest → live draft
    expect(r).toEqual({ index: -1, value: 'draft' });
  });

  test('↓ at the live draft is a no-op (stays -1)', () => {
    expect(historyStep(entries, -1, 'draft', 'next')).toEqual({ index: -1, value: 'draft' });
  });

  test('empty history: ↑ is a no-op on the draft', () => {
    expect(historyStep([], -1, 'draft', 'prev')).toEqual({ index: -1, value: 'draft' });
  });
});
