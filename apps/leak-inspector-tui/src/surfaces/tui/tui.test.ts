import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDuration } from './theme';
import { loadPreferences, savePreferences, DEFAULT_PREFERENCES } from './preferences';
import { TuiStore } from './store';
import type { AgentEvent } from '@mcpvul/agent-core';

describe('formatDuration', () => {
  test('seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(59_400)).toBe('59s');
  });
  test('minutes + seconds under an hour', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_599_000)).toBe('59m 59s');
  });
  test('hours + minutes beyond an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_780_000)).toBe('1h 3m');
  });
});

describe('preferences round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leakprefs-'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  afterEach(() => {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns defaults when no file exists, then persists + reloads', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    const path = savePreferences({ defaultMode: 'no_llm', defaultDynamic: 'aggressive', autoShowReport: true });
    expect(existsSync(path)).toBe(true);
    const loaded = loadPreferences();
    expect(loaded.defaultDynamic).toBe('aggressive');
    expect(loaded.autoShowReport).toBe(true);
    expect(loaded.defaultMode).toBe('no_llm');
  });
});

describe('TuiStore per-scan reset', () => {
  const turnEnd = (input: number, output: number, thinking: number): AgentEvent => ({
    type: 'turn_end',
    turn: 1,
    usage: { inputTokens: input, outputTokens: output, thinkingTokens: thinking },
  });

  test('beginRun resets tokens and inserts a divider, keeping old log', () => {
    const store = new TuiStore();
    store.beginRun('scan_a', 'llm_assisted');
    store.applyAgentEvent({ type: 'assistant_text', text: 'first scan output' });
    store.applyAgentEvent(turnEnd(100, 20, 5));
    expect(store.getSnapshot().usage).toEqual({ inputTokens: 100, outputTokens: 20, thinkingTokens: 5 });

    const beforeLen = store.getSnapshot().messages.length;
    expect(beforeLen).toBeGreaterThan(0);
    store.beginRun('scan_b', 'llm_assisted');
    const snap = store.getSnapshot();
    expect(snap.usage).toEqual({ inputTokens: 0, outputTokens: 0, thinkingTokens: 0 });
    expect(snap.scrollOffset).toBe(0);
    // Old messages kept + a "── new scan ──" divider appended.
    expect(snap.messages.length).toBe(beforeLen + 1);
    expect(snap.messages.some((m) => m.kind === 'phase' && m.text === '── new scan ──')).toBe(true);
  });

  test('io cue set on activity, cleared on tool_use', () => {
    const store = new TuiStore();
    store.beginRun('s', 'llm_assisted');
    store.setIo('up');
    expect(store.getSnapshot().io).toBe('up');
    store.setIo('down');
    expect(store.getSnapshot().io).toBe('down');
    store.applyAgentEvent({ type: 'tool_use', id: 't1', name: 'read_file', input: {}, isReadOnly: true });
    expect(store.getSnapshot().io).toBeUndefined();
  });

  test('finishRun warns when dynamic enabled but no dynamic tool ran', () => {
    const store = new TuiStore({ dynamic: 'selective' });
    store.beginRun('s', 'llm_assisted');
    store.finishRun('/tmp/results/s', { candidates: 1, confirmed: 0, likely: 1 });
    const warned = store
      .getSnapshot()
      .messages.some((m) => m.kind === 'system' && (m.text ?? '').includes('dynamic was enabled but the agent ran no dynamic tools'));
    expect(warned).toBe(true);
  });

  test('finishRun does NOT warn when a dynamic tool ran', () => {
    const store = new TuiStore({ dynamic: 'selective' });
    store.beginRun('s', 'llm_assisted');
    store.applyAgentEvent({ type: 'tool_use', id: 'd1', name: 'lsanRun', input: {}, isReadOnly: false });
    store.finishRun('/tmp/results/s', { candidates: 1, confirmed: 1, likely: 0 });
    const warned = store
      .getSnapshot()
      .messages.some((m) => m.kind === 'system' && (m.text ?? '').includes('ran no dynamic tools'));
    expect(warned).toBe(false);
  });
});
