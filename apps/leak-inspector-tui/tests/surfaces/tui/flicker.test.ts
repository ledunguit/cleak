/**
 * Flicker elimination tests.
 *
 * Ink v5 can emit `clearTerminal` (full-reset) when rendered content height
 * equals the viewport, or when content shrinks from above-viewport to
 * at-or-below. This causes visible flicker.
 *
 * The fix removes both triggers at two levels:
 *  - L1 (layout): FullscreenLayout no longer uses `height={terminalRows}`;
 *    the StackLayout uses `flexGrow={1}` so content height is never pinned
 *    to the viewport.
 *  - L2 (store): The store isolates unrelated patches (e.g. usage tokens)
 *    from the `view` selector, so keystroke-driven changes do not cascade
 *    into layout re-renders.
 *  - L0 (opt-in): `isFullscreenEnvEnabled()` defaults to `false`, so the
 *    default layout path (StackLayout) never triggers the full-clear.
 *
 * These tests verify the STRUCTURAL invariants without requiring a real
 * terminal or ink-testing-library.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createTestState } from './test-helpers';
import { isFullscreenEnvEnabled } from '../../../src/surfaces/tui/layout/layoutFlags';

// ── L2: Store-level isolation ──

describe('flicker elimination (store level)', () => {
  test('store patch for unrelated field does not change view selector', () => {
    const store = createTestState();

    // Initial state: view is 'main'
    expect(store.getSnapshot().view).toBe('main');

    // beginRun patches status, scanId, mode, etc. but NOT view
    store.beginRun('s1', 'llm_assisted');
    expect(store.getSnapshot().view).toBe('main');

    // A turn_end event patches `usage` tokens — unrelated to view
    store.applyAgentEvent({
      type: 'turn_end',
      turn: 1,
      usage: { inputTokens: 100, outputTokens: 20, thinkingTokens: 5 },
    });
    // view remains 'main' — the store correctly isolates unrelated state
    expect(store.getSnapshot().view).toBe('main');

    // Snapshot reference changes on every access.set(), confirming the
    // selector would NOT see a stale reference
    const afterTurnEnd = store.getSnapshot();
    expect(afterTurnEnd.usage).toEqual({ inputTokens: 100, outputTokens: 20, thinkingTokens: 5 });
    expect(afterTurnEnd.view).toBe('main');
  });

  test('config toggle does not change view or clobber usage', () => {
    const store = createTestState();
    store.beginRun('s1', 'llm_assisted');
    store.applyAgentEvent({
      type: 'turn_end',
      turn: 1,
      usage: { inputTokens: 50, outputTokens: 10, thinkingTokens: 2 },
    });

    // Simulate a user config interaction (e.g. Shift+Tab for permission mode)
    store.setAutoShowReport(true);
    const snap = store.getSnapshot();
    expect(snap.autoShowReport).toBe(true);
    // view must remain unchanged — the patch targets only autoShowReport
    expect(snap.view).toBe('main');
    // usage must survive the patch — unrelated fields are preserved
    expect(snap.usage).toEqual({ inputTokens: 50, outputTokens: 10, thinkingTokens: 2 });
  });

  test('scroll keystroke does not trigger a view change', () => {
    const store = createTestState();
    store.beginRun('s1', 'llm_assisted');
    store.scrollBy(5, 100);
    expect(store.getSnapshot().view).toBe('main');
    expect(store.getSnapshot().scrollOffset).toBe(5);
  });
});

// ── L1: Layout-level invariants ──

describe('flicker elimination (layout level)', () => {
  test('FullscreenLayout does not use height={terminalRows}', async () => {
    // import.meta.dir = apps/leak-inspector-tui/tests/surfaces/tui
    // ../../../ = apps/leak-inspector-tui
    const srcDir = join(import.meta.dir!, '..', '..', '..', 'src');
    const source = await Bun.file(
      join(srcDir, 'surfaces/tui/layout/FullscreenLayout.tsx'),
    ).text();

    // These patterns would trigger the Ink v5 full-clear when content
    // height matches viewport height
    expect(source).not.toContain('height={terminalRows}');
    // useStdout is mentioned in a JSDoc comment but NOT imported — verify
    // that the import line doesn't import it (no calling code either)
    expect(source.match(/import\s*\{[^}]*useStdout[^}]*\}/)).toBeNull();
    // The fix uses flexGrow instead of height={terminalRows}
    expect(source).toContain('flexGrow={1}');
  });

  test('StackLayout uses flexGrow not height={terminalRows}', async () => {
    const srcDir = join(import.meta.dir!, '..', '..', '..', 'src');
    const source = await Bun.file(
      join(srcDir, 'surfaces/tui/layout/StackLayout.tsx'),
    ).text();

    // StackLayout is the default layout — it must NOT use the problematic
    // pattern either. Its outer Box uses height="100%" (flex-parent-relative)
    // which is safe, and the scroll area uses flexGrow={1}.
    expect(source).not.toContain('height={terminalRows}');
    expect(source).not.toContain('useStdout');
    expect(source).toContain('flexGrow={1}');
  });

  test('layoutFlags module has no terminal dependency', async () => {
    const srcDir = join(import.meta.dir!, '..', '..', '..', 'src');
    const source = await Bun.file(
      join(srcDir, 'surfaces/tui/layout/layoutFlags.ts'),
    ).text();

    // The flag function must be a pure env-var check with no I/O
    expect(source).toContain('process.env.CLEAK_FULLSCREEN');
    expect(source).not.toContain('import');
    expect(source).not.toContain('require');
  });
});

// ── L0: Opt-in default ──

describe('flicker elimination (opt-in default)', () => {
  // Preserve env across the two tests
  let previous: string | undefined;

  afterEach(() => {
    if (previous !== undefined) process.env.CLEAK_FULLSCREEN = previous;
    else delete process.env.CLEAK_FULLSCREEN;
  });

  test('isFullscreenEnvEnabled defaults to false without CLEAK_FULLSCREEN', () => {
    previous = process.env.CLEAK_FULLSCREEN;
    delete process.env.CLEAK_FULLSCREEN;
    // Purge any cached import — Bun caches modules, but since the function
    // reads process.env at call time (not import time), a fresh function ref
    // isn't strictly necessary. However, for belt-and-suspenders we re-import.
    // Using a dynamic import with a cache-busting param is unreliable, so
    // we just rely on the call-time read.
    expect(isFullscreenEnvEnabled()).toBe(false);
  });

  test('isFullscreenEnvEnabled returns true with CLEAK_FULLSCREEN=1', () => {
    previous = process.env.CLEAK_FULLSCREEN;
    process.env.CLEAK_FULLSCREEN = '1';
    expect(isFullscreenEnvEnabled()).toBe(true);
  });

  test('isFullscreenEnvEnabled is case-sensitive — only "1" activates', () => {
    previous = process.env.CLEAK_FULLSCREEN;
    process.env.CLEAK_FULLSCREEN = 'true';
    expect(isFullscreenEnvEnabled()).toBe(false);
    process.env.CLEAK_FULLSCREEN = 'yes';
    expect(isFullscreenEnvEnabled()).toBe(false);
    process.env.CLEAK_FULLSCREEN = '';
    expect(isFullscreenEnvEnabled()).toBe(false);
  });
});
