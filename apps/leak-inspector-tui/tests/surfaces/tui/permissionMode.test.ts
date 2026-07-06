import { describe, expect, test } from 'bun:test';
import { TuiStore } from '../../../src/surfaces/tui/store';

describe('permission mode (Shift+Tab auto-accept)', () => {
  test('defaults to ask', () => {
    expect(new TuiStore().getSnapshot().permissionMode).toBe('ask');
  });

  test('cyclePermissionMode toggles ask ↔ auto', () => {
    const s = new TuiStore();
    expect(s.cyclePermissionMode()).toBe('auto');
    expect(s.getSnapshot().permissionMode).toBe('auto');
    expect(s.cyclePermissionMode()).toBe('ask');
    expect(s.getSnapshot().permissionMode).toBe('ask');
  });

  test('ask mode opens a pending prompt and resolves on the decision', async () => {
    const s = new TuiStore();
    const p = s.requestPermission({ id: '1', name: 'valgrindMemcheck', input: {} });
    expect(s.getSnapshot().pendingPermission?.name).toBe('valgrindMemcheck');
    s.resolvePermission('allow');
    expect(await p).toBe('allow');
    expect(s.getSnapshot().pendingPermission).toBeUndefined();
  });

  test('auto mode approves silently — no prompt is shown', async () => {
    const s = new TuiStore();
    s.cyclePermissionMode(); // → auto
    const decision = await s.requestPermission({ id: '2', name: 'asanRun', input: {} });
    expect(decision).toBe('allow');
    expect(s.getSnapshot().pendingPermission).toBeUndefined();
  });

  test('toggling to auto while a prompt is open approves the pending request', async () => {
    const s = new TuiStore();
    const p = s.requestPermission({ id: '3', name: 'runBinary', input: {} });
    expect(s.getSnapshot().pendingPermission).toBeDefined();
    s.cyclePermissionMode(); // → auto, should resolve the open prompt
    expect(await p).toBe('allow');
    expect(s.getSnapshot().pendingPermission).toBeUndefined();
  });
});
