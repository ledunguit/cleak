import { describe, expect, test, vi, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock the compiler/linker calls so this test doesn't need real bear/clang — every
// `runConfined` call succeeds and, when the args contain `-o <path>`, creates an
// empty file there (HarnessBuildService only checks `existsSync` on it).
vi.mock('../../src/services/safe-exec', () => ({
  sanitizeRunId: (id: string, fallbackPrefix = 'run') => {
    const clean = (id || '').replace(/[^A-Za-z0-9_]/g, '');
    return clean.length ? clean : `${fallbackPrefix}_unknown`;
  },
  intEnv: (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  },
  runConfined: async (_cmd: string, args: string[], opts: { cwd?: string } = {}) => {
    if (args[0] === '--') {
      // bear invocation — write a minimal compile_commands.json covering util.c.
      const cwd = opts.cwd!;
      writeFileSync(
        join(cwd, 'compile_commands.json'),
        JSON.stringify([{ directory: cwd, file: 'util.c', arguments: ['clang', '-c', 'util.c', '-o', 'util.o'] }]),
      );
      return { stdout: '', stderr: '', code: 0, timedOut: false };
    }
    const oIdx = args.indexOf('-o');
    if (oIdx >= 0 && args[oIdx + 1]) writeFileSync(args[oIdx + 1], '');
    return { stdout: '', stderr: '', code: 0, timedOut: false };
  },
}));

import { HarnessBuildService } from '../../src/services/harness-build.service';
import { CompileCommandsService } from '../../src/services/compile-commands.service';

// HarnessBuildService now enforces WORKSPACE_ROOT containment (path-guard.ts) —
// project/runs dirs must live inside a sandbox root. getWorkspaceRoot() caches
// on first call, so the env is set ONCE at module top and every dir is created
// under the same (canonical) root.
const sandboxRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cleak-ws-')));
const prevWorkspaceRoot = process.env.WORKSPACE_ROOT;
process.env.WORKSPACE_ROOT = sandboxRoot;

afterAll(() => {
  if (prevWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = prevWorkspaceRoot;
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe('HarnessBuildService — run-dir retention', () => {
  test('keeps only DYNAMIC_HARNESS_MAX_RUN_DIRS most recent harness_* directories', async () => {
    const runsDir = mkdtempSync(join(sandboxRoot, 'runs-'));
    const projectDir = mkdtempSync(join(sandboxRoot, 'proj-'));
    writeFileSync(join(projectDir, 'util.c'), 'char *f(void){return 0;}');
    const prevRunsDir = process.env.RUNS_DIR;
    const prevMax = process.env.DYNAMIC_HARNESS_MAX_RUN_DIRS;
    process.env.RUNS_DIR = runsDir;
    process.env.DYNAMIC_HARNESS_MAX_RUN_DIRS = '3';
    try {
      // Seed 5 pre-existing fake harness_* dirs with distinct mtimes.
      for (let i = 0; i < 5; i++) {
        const dir = join(runsDir, `harness_seed_${i}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'harness_bin'), '');
        await new Promise((r) => setTimeout(r, 5));
      }

      const svc = new HarnessBuildService(new CompileCommandsService());
      const result = await svc.build({
        projectPath: projectDir,
        buildCommand: 'clang -c util.c -o util.o',
        harnessSource: 'int main(void){return 0;}',
        targetFile: join(projectDir, 'util.c'),
        closureFiles: [],
        entryStyle: 'single',
        timeoutSec: 30,
      });
      expect(result.success).toBe(true);

      const remaining = readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('harness_'));
      expect(remaining.length).toBe(3);
      // The just-built run (newest) must survive the sweep.
      expect(remaining.some((e) => e.name === result.runId)).toBe(true);
    } finally {
      if (prevRunsDir === undefined) delete process.env.RUNS_DIR;
      else process.env.RUNS_DIR = prevRunsDir;
      if (prevMax === undefined) delete process.env.DYNAMIC_HARNESS_MAX_RUN_DIRS;
      else process.env.DYNAMIC_HARNESS_MAX_RUN_DIRS = prevMax;
      rmSync(runsDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
