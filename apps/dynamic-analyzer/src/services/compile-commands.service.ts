/**
 * Recovers the REAL per-file compiler flags (`-I`, `-D`, `-std=`, …) a project's own
 * build used, via `bear` (https://github.com/rizsotto/Bear) intercepting the actual
 * `buildCommand` and emitting `compile_commands.json`. This is what makes targeted
 * harness compilation (`HarnessBuildService`) possible without hand-reconstructing a
 * project's build config: the harness for a candidate function is compiled with the
 * SAME flags the real build used for that file, recovered mechanically instead of
 * guessed.
 *
 * No shelling out to a nested Docker container — `bear -- sh -c '<buildCommand>'`
 * runs via the SAME confined `runConfined` used for sanitizer runs (argv-array
 * `execFile`, no outer shell, ulimit-wrapped on Linux). The inner `sh -c` interprets
 * `buildCommand`'s own shell syntax exactly as `execSync` already does in
 * `BuildTargetService` — this doesn't add injection surface, `buildCommand` was
 * already trusted-operator-supplied and shell-executed before this change.
 */

import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { runConfined } from './safe-exec';
import { assertInsideWorkspace } from './path-guard';

export interface CompileEntry {
  directory: string;
  args: string[];
}

interface CdbEntryRaw {
  directory?: string;
  file: string;
  command?: string;
  arguments?: string[];
}

export interface CompileCommandsResult {
  index: Map<string, CompileEntry>;
  error?: string;
}

/** Small POSIX-ish shell-word splitter for bear's legacy `command` (string) form —
 * handles quotes embedded mid-token (`-DX="a b"`), not just whole-token quoting. */
export function splitCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let started = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) cur += command[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      started = true;
    } else if (ch === '"') {
      inDouble = true;
      started = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

/** BLOCKLIST, not allowlist: keep every flag the real build used EXCEPT the ones
 * provably wrong to reuse for a different (harness) source file. An allowlist here
 * silently drops anything not explicitly named — real builds carry flags
 * (`-pthread`, `--target=`, `-arch`, `-fpack-struct`, `-fms-extensions`, …) that
 * change ABI/struct-layout/behavior; dropping them lets the harness compile
 * successfully while quietly diverging from the real build with no error. Only drop
 * what's KNOWN unsafe/irrelevant to carry over:
 *   - `-o <file>` / `-c` — the harness build controls its own output and always
 *     needs a full compile+link, not object-only.
 *   - `-fsanitize*` — the harness build picks its own (address, or fuzzer+address).
 *   - `-Werror` — a warning in the harness's own generated code shouldn't hard-fail.
 *   - `-MT/-MF/-MQ` (separate or joined form) and `-MD/-MMD/-MP/-MG` — dependency-file
 *     generation flags reference specific `.d`/target paths that aren't valid for a
 *     different source file.
 *   - bare positional arguments that look like a C/C++ SOURCE file — the caller
 *     supplies its own harness/closure sources explicitly; keeping the original
 *     source path here would add an extra, unwanted translation unit.
 */
export function extractReusableFlags(args: string[]): string[] {
  const keep: string[] = [];
  const dropsNextValue = new Set(['-o', '-MF', '-MT', '-MQ']);
  const dropsFlagOnly = new Set(['-c', '-Werror', '-MD', '-MMD', '-MP', '-MG']);
  const sourceExt = /\.(c|cc|cpp|cxx|c\+\+|m|mm)$/i;
  for (let i = 1; i < args.length; i++) {
    // i=0 is the compiler binary itself.
    const a = args[i];
    if (dropsNextValue.has(a)) {
      i++;
      continue;
    }
    if (dropsFlagOnly.has(a)) continue;
    if (a.startsWith('-fsanitize')) continue;
    if (/^-M[FTQ]\S/.test(a)) continue; // joined form: -MFfoo.d / -MTfoo / -MQfoo
    if (!a.startsWith('-') && sourceExt.test(a)) continue; // positional source file
    keep.push(a);
  }
  return keep;
}

@Injectable()
export class CompileCommandsService {
  private readonly logger = new Logger(CompileCommandsService.name);

  /** In-flight captures keyed by canonicalized projectPath. `CompileCommandsService`
   * is a NestJS singleton — one instance shared by every `buildHarness` call in a
   * scan — so this de-dupes concurrent Stage B2 harness workers that both start
   * before `compile_commands.json` exists: without it, two workers can both see it
   * missing and both spawn `bear` over the SAME (possibly non-reentrant) build at
   * once. Callers for the same project now await the SAME capture instead. */
  private readonly inFlight = new Map<string, Promise<CompileCommandsResult>>();

  /** Ensure `compile_commands.json` exists at `projectPath` (capturing it via `bear`
   * if absent) and return it parsed into a `relative-path → flags` index. */
  async capture(projectPath: string, buildCommand: string, timeoutSec = 300): Promise<CompileCommandsResult> {
    // WORKSPACE_ROOT containment (SECURITY.md): never run `bear` over a project
    // path outside the sandbox.
    let canonical: string;
    try {
      canonical = assertInsideWorkspace(projectPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { index: new Map(), error: msg };
    }
    const key = existsSync(canonical) ? canonical : projectPath;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const p = this.doCapture(canonical, buildCommand, timeoutSec).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async doCapture(projectPath: string, buildCommand: string, timeoutSec: number): Promise<CompileCommandsResult> {
    const cdbPath = join(projectPath, 'compile_commands.json');
    if (!existsSync(cdbPath)) {
      // RESIDUAL RISK (per docs/SECURITY.md): `buildCommand` is an
      // operator-supplied shell command — `sh -c` interprets its own syntax,
      // exactly as BuildTargetService's execSync does. Nothing untrusted is
      // interpolated by this code; the outer call is argv-array, no shell.
      const result = await runConfined('bear', ['--', 'sh', '-c', buildCommand], {
        cwd: projectPath,
        timeoutSec,
      });
      if (!existsSync(cdbPath)) {
        const detail = (result.stderr || result.stdout || '').slice(0, 500);
        this.logger.warn(`bear capture produced no compile_commands.json in ${projectPath}: ${detail}`);
        return {
          index: new Map(),
          error: `compile_commands.json not produced (bear unavailable, or the build system isn't captured by it): ${detail}`,
        };
      }
    }
    try {
      const raw = JSON.parse(readFileSync(cdbPath, 'utf-8')) as CdbEntryRaw[];
      const index = new Map<string, CompileEntry>();
      for (const e of raw) {
        const key = this.relativeKey(e, projectPath);
        if (!key) continue;
        const args = e.arguments ?? (e.command ? splitCommandLine(e.command) : []);
        if (args.length === 0) continue;
        index.set(key, { directory: e.directory || projectPath, args });
      }
      return { index };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { index: new Map(), error: `failed to parse compile_commands.json: ${msg}` };
    }
  }

  /** Delete a stale `compile_commands.json` so the next `capture()` re-runs `bear`
   * (e.g. after the caller mutated the project between scans). Best-effort. */
  invalidate(projectPath: string): void {
    try {
      const cdbPath = join(projectPath, 'compile_commands.json');
      if (existsSync(cdbPath)) unlinkSync(cdbPath);
    } catch {
      /* best-effort */
    }
  }

  private relativeKey(e: CdbEntryRaw, projectPath: string): string | null {
    if (!e.file) return null;
    const abs = isAbsolute(e.file) ? e.file : join(e.directory || projectPath, e.file);
    const rel = relative(projectPath, abs);
    if (rel.startsWith('..')) return null; // outside the project — not resolvable by us
    return rel.split(sep).join('/');
  }
}

/** Look up the captured compile entry for a caller-supplied (analyzer-side, absolute)
 * file path, keyed the same way `capture()` indexed `compile_commands.json`. */
export function resolveCompileEntry(
  index: Map<string, CompileEntry>,
  projectPath: string,
  filePath: string,
): CompileEntry | undefined {
  const rel = relative(projectPath, resolve(filePath)).split(sep).join('/');
  return index.get(rel);
}
