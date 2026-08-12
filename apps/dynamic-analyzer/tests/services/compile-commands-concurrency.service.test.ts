import { describe, expect, test, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Two concurrent `capture()` calls for the SAME project must not both spawn `bear` —
// this mock simulates a slow bear invocation (so the calls actually overlap) and
// writes compile_commands.json as bear itself would, letting the real fs checks in
// `doCapture` succeed without touching the real `bear` binary.
// vi.mock() factories are hoisted above imports AND above any preceding top-level
// code, so the vi.fn() they reference must be created via vi.hoisted() — otherwise
// it would still be in its TDZ when the (also-hoisted) factory runs. The call
// counter is tracked via the mock's own `.mock.calls` rather than a closed-over
// `let`, since a plain mutable counter can't survive the hoist either.
const { mockRunConfined } = vi.hoisted(() => ({
  mockRunConfined: vi.fn(async (_cmd: string, _args: string[], opts: { cwd?: string } = {}) => {
    await new Promise((r) => setTimeout(r, 30));
    if (opts.cwd) {
      writeFileSync(
        join(opts.cwd, 'compile_commands.json'),
        JSON.stringify([{ directory: opts.cwd, file: 'foo.c', arguments: ['clang', '-Ifoo', '-c', 'foo.c', '-o', 'foo.o'] }]),
      );
    }
    return { stdout: '', stderr: '', code: 0, timedOut: false };
  }),
}));

vi.mock('../../src/services/safe-exec', () => ({
  runConfined: mockRunConfined,
}));

import { CompileCommandsService } from '../../src/services/compile-commands.service';

// capture() now enforces WORKSPACE_ROOT containment (path-guard.ts) — the
// per-test temp projects must live inside a sandbox root. getWorkspaceRoot()
// caches on first call, so the env is set ONCE at module top (before any
// capture()) and every project dir is created under the same root.
const sandboxRoot = mkdtempSync(join(tmpdir(), 'cleak-ws-'));
const prevWorkspaceRoot = process.env.WORKSPACE_ROOT;
process.env.WORKSPACE_ROOT = sandboxRoot;

afterAll(() => {
  if (prevWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = prevWorkspaceRoot;
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe('CompileCommandsService.capture — concurrency', () => {
  test('two concurrent capture() calls for the same project run bear only ONCE', async () => {
    const dir = mkdtempSync(join(sandboxRoot, 'case-'));
    try {
      mockRunConfined.mockClear();
      const svc = new CompileCommandsService();
      const [a, b] = await Promise.all([svc.capture(dir, 'clang -c foo.c -o foo.o'), svc.capture(dir, 'clang -c foo.c -o foo.o')]);
      expect(mockRunConfined).toHaveBeenCalledTimes(1);
      expect(a.error).toBeUndefined();
      expect(b.error).toBeUndefined();
      expect(a.index.get('foo.c')).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a later capture() after the first resolves does NOT re-invoke bear (file already cached)', async () => {
    const dir = mkdtempSync(join(sandboxRoot, 'case-'));
    try {
      mockRunConfined.mockClear();
      const svc = new CompileCommandsService();
      await svc.capture(dir, 'clang -c foo.c -o foo.o');
      expect(mockRunConfined).toHaveBeenCalledTimes(1);
      await svc.capture(dir, 'clang -c foo.c -o foo.o');
      expect(mockRunConfined).toHaveBeenCalledTimes(1); // compile_commands.json already exists — no re-run
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
