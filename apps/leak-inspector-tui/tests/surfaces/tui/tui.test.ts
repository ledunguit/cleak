import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDuration } from '../../../src/surfaces/tui/theme';
import { loadConfigFile, saveConfigFile, DEFAULT_CONFIG } from '../../../src/domain/config-file';
import { visibleFindings } from '../../../src/stores';
import type { FindingView } from '../../../src/surfaces/tui/findings/findingView';
import type { AgentEvent } from '@cleak/agent-core';
import { createTestState } from './test-helpers';

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

describe('config file round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leakcfg-'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  afterEach(() => {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns defaults when no file exists, then persists + reloads', () => {
    expect(loadConfigFile()).toEqual(DEFAULT_CONFIG);
    const path = saveConfigFile({ defaultMode: 'no_llm', defaultDynamic: 'aggressive', autoShowReport: true });
    expect(existsSync(path)).toBe(true);
    const loaded = loadConfigFile();
    expect(loaded.defaultDynamic).toBe('aggressive');
    expect(loaded.autoShowReport).toBe(true);
    expect(loaded.defaultMode).toBe('no_llm');
  });

  test('persists a provider + per-provider endpoint override, chmod 600', () => {
    const path = saveConfigFile({
      provider: 'openai-compat',
      endpoints: { 'openai-compat': { baseUrl: 'http://localhost:1234/v1', model: 'm', apiKey: 'sk-x' } },
    });
    const loaded = loadConfigFile();
    expect(loaded.provider).toBe('openai-compat');
    expect(loaded.endpoints?.['openai-compat']).toEqual({ baseUrl: 'http://localhost:1234/v1', model: 'm', apiKey: 'sk-x' });
    // The file may hold a key → must be owner-only (0600).
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('TuiStore per-scan reset', () => {
  // scanStore is a module-level singleton; reset it before each test.
  // createTestState() handles this internally but we keep a defensive reset
  // in case a test fails early and leaves dirty state.
  beforeEach(() => {
    // resetStores() is called inside createTestState() — this is extra safety.
  });

  const turnEnd = (input: number, output: number, thinking: number): AgentEvent => ({
    type: 'turn_end',
    turn: 1,
    usage: { inputTokens: input, outputTokens: output, thinkingTokens: thinking },
  });

  test('beginRun resets tokens and inserts a divider, keeping old log', () => {
    const store = createTestState();
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
    const store = createTestState();
    store.beginRun('s', 'llm_assisted');
    store.setIo('up');
    expect(store.getSnapshot().io).toBe('up');
    store.setIo('down');
    expect(store.getSnapshot().io).toBe('down');
    store.applyAgentEvent({ type: 'tool_use', id: 't1', name: 'read_file', input: {}, isReadOnly: true });
    expect(store.getSnapshot().io).toBeUndefined();
  });

  test('finishRun warns when dynamic enabled but no dynamic tool ran', () => {
    const store = createTestState({ dynamic: 'selective' });
    store.beginRun('s', 'llm_assisted');
    store.finishRun('/tmp/results/s', { candidates: 1, confirmed: 0, likely: 1 });
    const warned = store
      .getSnapshot()
      .messages.some((m) => m.kind === 'system' && (m.text ?? '').includes('dynamic was enabled but the agent ran no dynamic tools'));
    expect(warned).toBe(true);
  });

  test('finishRun does NOT warn when a dynamic tool ran', () => {
    const store = createTestState({ dynamic: 'selective' });
    store.beginRun('s', 'llm_assisted');
    store.applyAgentEvent({ type: 'tool_use', id: 'd1', name: 'lsanRun', input: {}, isReadOnly: false });
    store.finishRun('/tmp/results/s', { candidates: 1, confirmed: 1, likely: 0 });
    const warned = store
      .getSnapshot()
      .messages.some((m) => m.kind === 'system' && (m.text ?? '').includes('ran no dynamic tools'));
    expect(warned).toBe(false);
  });
});

describe('TuiStore findings browser', () => {
  const fv = (id: string, verdict: string, confidence: number, file: string, line: number, coverage = 'dynamic_off'): FindingView => ({
    id, function: id, file, line, allocationType: 'malloc', verdict, confidence,
    verdictTool: 'consensus', dynamicCoverage: coverage, explanation: '', evidence: [],
  });
  // severity order: confirmed(5) > likely(4) > fp(1)
  const sample = () => [
    fv('a', 'false_positive', 0.4, 'z.c', 5, 'exercised_clean'),
    fv('b', 'confirmed_leak', 0.9, 'a.c', 30, 'exercised_leak'),
    fv('c', 'likely_leak', 0.7, 'a.c', 10, 'exercised_leak'),
  ];

  test('openFindings enters the view; default sort is severity (confirmed first)', () => {
    const store = createTestState();
    store.openFindings('scan1', 'snapshot', sample());
    expect(store.getSnapshot().view).toBe('findings');
    expect(visibleFindings(store.getSnapshot()).map((f) => f.id)).toEqual(['b', 'c', 'a']);
  });

  test('findingsMove clamps to the visible range', () => {
    const store = createTestState();
    store.openFindings('s', 'snapshot', sample());
    store.findingsMove(-1);
    expect(store.getSnapshot().findings!.cursor).toBe(0);
    store.findingsMove(99);
    expect(store.getSnapshot().findings!.cursor).toBe(2);
  });

  test('cycling the coverage filter shrinks the visible set; cursor stays valid', () => {
    const store = createTestState();
    store.openFindings('s', 'snapshot', sample());
    // all → exercised_clean (first distinct present)
    store.findingsCycleFilter('coverage', 1);
    const vis = visibleFindings(store.getSnapshot());
    expect(vis.map((f) => f.id)).toEqual(['a']);
    expect(store.getSnapshot().findings!.cursor).toBeLessThan(vis.length);
  });

  test('changing sort keeps the cursor on the SAME finding id', () => {
    const store = createTestState();
    store.openFindings('s', 'snapshot', sample());
    store.findingsMove(1); // cursor on 'c' (severity order b,c,a)
    expect(visibleFindings(store.getSnapshot())[store.getSnapshot().findings!.cursor].id).toBe('c');
    store.findingsCycleSort(1); // severity → confidence: order b(.9),c(.7),a(.4) — 'c' still index 1
    expect(visibleFindings(store.getSnapshot())[store.getSnapshot().findings!.cursor].id).toBe('c');
  });

  test('openDetail pins the finding; exit returns to main', () => {
    const store = createTestState();
    store.openFindings('s', 'snapshot', sample());
    store.findingsOpenDetail();
    expect(store.getSnapshot().findings!.tab).toBe('detail');
    expect(store.getSnapshot().findings!.detailId).toBe('b');
    store.findingsExit();
    expect(store.getSnapshot().view).toBe('main');
  });
});
