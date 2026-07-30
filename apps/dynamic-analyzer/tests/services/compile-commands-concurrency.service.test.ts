import { describe, expect, test, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let bearCallCount = 0;

// Two concurrent `capture()` calls for the SAME project must not both spawn `bear` —
// this mock simulates a slow bear invocation (so the calls actually overlap) and
// writes compile_commands.json as bear itself would, letting the real fs checks in
// `doCapture` succeed without touching the real `bear` binary.
mock.module('../../src/services/safe-exec', () => ({
  runConfined: async (_cmd: string, _args: string[], opts: { cwd?: string } = {}) => {
    bearCallCount++;
    await new Promise((r) => setTimeout(r, 30));
    if (opts.cwd) {
      writeFileSync(
        join(opts.cwd, 'compile_commands.json'),
        JSON.stringify([{ directory: opts.cwd, file: 'foo.c', arguments: ['clang', '-Ifoo', '-c', 'foo.c', '-o', 'foo.o'] }]),
      );
    }
    return { stdout: '', stderr: '', code: 0, timedOut: false };
  },
}));

import { CompileCommandsService } from '../../src/services/compile-commands.service';

describe('CompileCommandsService.capture — concurrency', () => {
  test('two concurrent capture() calls for the same project run bear only ONCE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleak-cdb-'));
    try {
      bearCallCount = 0;
      const svc = new CompileCommandsService();
      const [a, b] = await Promise.all([svc.capture(dir, 'clang -c foo.c -o foo.o'), svc.capture(dir, 'clang -c foo.c -o foo.o')]);
      expect(bearCallCount).toBe(1);
      expect(a.error).toBeUndefined();
      expect(b.error).toBeUndefined();
      expect(a.index.get('foo.c')).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a later capture() after the first resolves does NOT re-invoke bear (file already cached)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleak-cdb-'));
    try {
      bearCallCount = 0;
      const svc = new CompileCommandsService();
      await svc.capture(dir, 'clang -c foo.c -o foo.o');
      expect(bearCallCount).toBe(1);
      await svc.capture(dir, 'clang -c foo.c -o foo.o');
      expect(bearCallCount).toBe(1); // compile_commands.json already exists — no re-run
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
