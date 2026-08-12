/**
 * Flicker elimination tests.
 *
 * Ink v5 can emit `clearTerminal` (full-reset) when rendered content height
 * equals the viewport, or when content shrinks from above-viewport to
 * at-or-below. This causes visible flicker.
 *
 * L2 (store): The store isolates unrelated patches (e.g. usage tokens) from
 * the `view` selector, so keystroke-driven changes do not cascade into
 * layout re-renders.
 *
 * (The former L0/L1 layout-level invariants guarded FullscreenLayout /
 * StackLayout / layoutFlags, which have been removed as dead code.)
 */
import { describe, expect, test } from 'vitest';
import { createTestState } from './test-helpers';

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
