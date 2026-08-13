/**
 * Compiles a TARGETED harness — a small driver written by the orchestrator's harness
 * worker that calls just one suspicious function/call-chain — against the REAL
 * project's own compiler flags (via `CompileCommandsService`), instead of running the
 * whole project's binary blind (`BuildTargetService`/`runDeterministicDynamic`).
 *
 * Two linkage strategies, chosen by the CALLER (the harness source itself), not this
 * service:
 *   - external linkage: `harnessSource` `extern`-declares the target function and
 *     `closureFiles` lists the `.c`/`.cpp` file(s) to compile+link against.
 *   - `static` (internal) linkage: the target function can't be linked across a TU,
 *     so `harnessSource` must `#include` the defining file directly — in that case
 *     the caller must NOT also list that file in `closureFiles` (would ODR-duplicate
 *     it). This is enforced by convention (documented on the MCP tool + harness
 *     worker prompt), not re-derived here.
 *
 * Compilation/linking runs through the SAME confined, no-shell `runConfined` used for
 * sanitizer runs — see `safe-exec.ts`. This is new attack surface (compiling
 * LLM/orchestrator-authored C source) not covered by `BuildTargetService` (which only
 * ever compiles the SCANNED PROJECT's own build command) — see docs/SECURITY.md.
 */

import { Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import * as fs from 'fs';
import { basename, join } from 'path';
import { CompileCommandsService, extractReusableFlags, resolveCompileEntry } from './compile-commands.service';
import { runConfined, sanitizeRunId, intEnv } from './safe-exec';
import { assertInsideWorkspace, isPathInside } from './path-guard';

const MAX_CLOSURE_FILES = 8;
/** Cap on retained `harness_*` run directories under RUNS_DIR — each one carries
 * `.o`s + a linked binary (heavier than the JSON-only artifacts other tools leave),
 * so unlike those it needs a retention policy. Env-tunable like the rest of this
 * service's limits (`DYNAMIC_ULIMIT_*`, `DYNAMIC_BUILD_*`). */
const DEFAULT_MAX_HARNESS_RUN_DIRS = 50;
/** Always clang: `-fsanitize=fuzzer` requires it, and using ONE compiler for both
 * `entryStyle` values keeps ABI/flag behavior identical between the single-shot run
 * and its fuzz escalation (same harness source, same compiler, different entrypoint). */
const HARNESS_COMPILER = 'clang';

export interface HarnessBuildInput {
  projectPath: string;
  buildCommand: string;
  harnessSource: string;
  targetFile: string;
  closureFiles?: string[];
  entryStyle: 'single' | 'fuzzer';
  timeoutSec?: number;
}

export interface HarnessBuildResult {
  success: boolean;
  binaryPath: string;
  runId: string;
  errors: string[];
  reason?: 'harness_unresolvable';
}

@Injectable()
export class HarnessBuildService {
  private readonly logger = new Logger(HarnessBuildService.name);

  constructor(private readonly compileCommands: CompileCommandsService) {}

  async build(input: HarnessBuildInput): Promise<HarnessBuildResult> {
    const timeoutSec = input.timeoutSec ?? 120;
    const closureFiles = (input.closureFiles ?? []).slice(0, MAX_CLOSURE_FILES);
    const runId = sanitizeRunId(`harness_${Date.now()}`, 'harness');
    const runsDir = process.env.RUNS_DIR || './runs';
    const runDir = join(runsDir, runId);
    mkdirSync(runDir, { recursive: true });

    // WORKSPACE_ROOT containment (SECURITY.md): the scanned project must live
    // inside the sandbox; projectReal is the canonical root for file checks.
    let projectReal: string;
    try {
      projectReal = assertInsideWorkspace(input.projectPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.fail(runId, [msg]);
    }
    if (!existsSync(projectReal)) {
      return this.fail(runId, [`Project path does not exist: ${input.projectPath}`]);
    }

    // Containment: harness/closure file paths must resolve inside projectPath —
    // an LLM-authored `targetFile`/`closureFiles` value must not escape the
    // scanned repo. assertInsideWorkspace realpaths the deepest existing
    // ancestor, so a symlink inside the project that points OUTSIDE is rejected.
    for (const f of [input.targetFile, ...closureFiles]) {
      let canonical: string;
      try {
        canonical = assertInsideWorkspace(f);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return this.fail(runId, [`Path outside workspace: ${f} (${msg})`]);
      }
      if (!isPathInside(canonical, projectReal)) {
        return this.fail(runId, [`Path outside project: ${f}`]);
      }
    }

    const { index, error: cdbError } = await this.compileCommands.capture(input.projectPath, input.buildCommand, timeoutSec);
    if (cdbError) {
      return this.fail(runId, [cdbError], 'harness_unresolvable');
    }

    const targetEntry = resolveCompileEntry(index, input.projectPath, input.targetFile);
    if (!targetEntry) {
      return this.fail(
        runId,
        [`no compile_commands.json entry for ${input.targetFile} — build system may be unsupported`],
        'harness_unresolvable',
      );
    }

    // Structural sanity check BEFORE spending a compile/link cycle: `-fsanitize=fuzzer`
    // links libFuzzer's own `main()`, so a harness that also defines `main()` is a
    // guaranteed duplicate-symbol error, and a `single`-entry harness with no `main()`
    // has nothing to run. This is a caller-content defect (not an unsupported-build-
    // system signal), so it's a plain failure the worker can fix and retry — not
    // `harness_unresolvable`, which the worker is told never to retry after.
    if (input.entryStyle === 'fuzzer' && !input.harnessSource.includes('LLVMFuzzerTestOneInput')) {
      return this.fail(runId, [
        'harnessSource has no LLVMFuzzerTestOneInput but entryStyle="fuzzer" was requested — write the dual-entrypoint shape (see prompt) before building the fuzz variant.',
      ]);
    }
    if (input.entryStyle === 'single' && !/\bint\s+main\s*\(/.test(input.harnessSource)) {
      return this.fail(runId, [
        'harnessSource has no `int main(...)` but entryStyle="single" was requested — a single-shot harness needs a main() entry point.',
      ]);
    }

    const harnessExt = /\.(cc|cpp|cxx|hpp|hh)$/i.test(input.targetFile) ? 'cpp' : 'c';
    const harnessPath = join(runDir, `harness.${harnessExt}`);
    writeFileSync(harnessPath, input.harnessSource);

    const errors: string[] = [];
    const objectFiles: string[] = [];
    for (const cf of closureFiles) {
      const entry = resolveCompileEntry(index, input.projectPath, cf) ?? targetEntry;
      const flags = extractReusableFlags(entry.args);
      const objPath = join(runDir, `${basename(cf)}.o`);
      const args = [...flags, '-g', '-O0', '-fsanitize=address', '-c', cf, '-o', objPath];
      const r = await runConfined(HARNESS_COMPILER, args, { cwd: input.projectPath, timeoutSec });
      if (r.code !== 0 || !existsSync(objPath)) {
        errors.push(`closure file ${cf} failed to compile: ${(r.stderr || r.stdout).slice(0, 400)}`);
        continue;
      }
      objectFiles.push(objPath);
    }

    const targetFlags = extractReusableFlags(targetEntry.args);
    // `-DHARNESS_FUZZ` selects the `LLVMFuzzerTestOneInput` entry point in the SAME
    // harness source (see harnessWorkerSystemPrompt's required dual-mode shape) — the
    // harness never defines `main()` for a fuzzer build, avoiding a duplicate-`main`
    // link error against libFuzzer's own runtime main().
    const fuzzFlags = input.entryStyle === 'fuzzer' ? ['-fsanitize=fuzzer,address', '-DHARNESS_FUZZ'] : ['-fsanitize=address'];
    const binaryPath = join(runDir, 'harness_bin');
    const linkArgs = [...targetFlags, '-g', '-O0', ...fuzzFlags, harnessPath, ...objectFiles, '-lstdc++', '-o', binaryPath];
    const linkResult = await runConfined(HARNESS_COMPILER, linkArgs, { cwd: input.projectPath, timeoutSec });
    if (linkResult.code !== 0 || !existsSync(binaryPath)) {
      errors.push(`harness compile/link failed: ${(linkResult.stderr || linkResult.stdout).slice(0, 1000)}`);
      return this.fail(runId, errors);
    }

    this.saveMeta(runId, { success: true, binaryPath, errors });
    this.sweepOldRunDirs(runsDir);
    return { success: true, binaryPath, runId, errors };
  }

  /** Keep only the most recent `DYNAMIC_HARNESS_MAX_RUN_DIRS` (default 50) `harness_*`
   * run directories under RUNS_DIR, deleting older ones. Best-effort: never blocks or
   * fails the caller's build result on a cleanup error. */
  private sweepOldRunDirs(runsDir: string): void {
    try {
      const maxRetained = intEnv('DYNAMIC_HARNESS_MAX_RUN_DIRS', DEFAULT_MAX_HARNESS_RUN_DIRS);
      const entries = readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('harness_'))
        .map((e) => {
          const full = join(runsDir, e.name);
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(full).mtimeMs;
          } catch {
            /* entry vanished mid-sweep — treat as oldest */
          }
          return { full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
      for (const stale of entries.slice(maxRetained)) {
        try {
          rmSync(stale.full, { recursive: true, force: true });
        } catch (err) {
          this.logger.warn(`failed to remove stale harness run dir ${stale.full}: ${err}`);
        }
      }
    } catch (err) {
      this.logger.warn(`harness run-dir retention sweep failed: ${err}`);
    }
  }

  private fail(runId: string, errors: string[], reason?: 'harness_unresolvable'): HarnessBuildResult {
    this.saveMeta(runId, { success: false, reason, errors });
    // Failed builds still leave a run dir (harness source, any partial .o's) — sweep
    // here too, not just on success, so retention actually bounds disk usage.
    this.sweepOldRunDirs(process.env.RUNS_DIR || './runs');
    return { success: false, binaryPath: '', runId, errors, reason };
  }

  private saveMeta(runId: string, data: { success: boolean; reason?: string; errors: string[]; binaryPath?: string }): void {
    try {
      const runsDir = process.env.RUNS_DIR || './runs';
      fs.writeFileSync(
        join(runsDir, `${runId}.harnessbuild.json`),
        JSON.stringify({ runId, tool: 'harnessBuild', createdAt: new Date().toISOString(), ...data }, null, 2),
      );
    } catch (err) {
      this.logger.warn(`failed to persist harness build metadata for ${runId}: ${err}`);
    }
  }
}
