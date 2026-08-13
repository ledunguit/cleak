import { Injectable } from '@nestjs/common';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';

/**
 * Project-level Clang Static Analyzer pass.
 *
 * Runs `scan-build` DIRECTLY inside the static-analyzer container (clang +
 * clang-tools are baked into the image) — no nested `docker run`, no
 * docker.sock mount. scan-build intercepts the project's own build (the
 * supplied buildCommand) and emits Clang diagnostics in the form
 * `file:line:col: warning: ... [checker]`, which we parse into structured
 * findings. This is the "deep static" slot, exposed over MCP as
 * `scanBuildRun` / `scanBuildGetReport`. (NOTE: distinct from the per-TU
 * `clang --analyze` external baseline `ClangAnalyzerAdapter` in the TUI.)
 *
 * ── SECURITY ──
 * scan-build's whole job is to RUN the project's build, so `buildCommand` is
 * inherently arbitrary code execution inside this container. Containment =
 * the container boundary (no privileged, no docker.sock, localhost-bound MCP —
 * see docker-compose.yml / docs/SECURITY.md); the tool operator is trusted
 * with the build command for their own repo. What we DO harden here:
 *  - `projectPath` is canonicalized (resolve + realpath of the deepest existing
 *    ancestor) and must stay inside the WORKSPACE_ROOT sandbox (Docker:
 *    `/workspace` where the compose mounts live) — a `..` or symlink-out path
 *    is rejected before any process is spawned. On host dev (no /workspace, no
 *    WORKSPACE_ROOT) `..` segments are still collapsed but no root is enforced:
 *    the operator is the local user and the sandbox boundary does not exist.
 *  - `runId` in getReport is validated as `[A-Za-z0-9_-]+` before it touches a
 *    filename, so a caller-supplied runId cannot traverse out of RUNS_DIR
 *    (e.g. `getReport("../../etc/…")` reading an arbitrary JSON file).
 *  - For a metachar-free command the build is passed as an argv ARRAY (no shell,
 *    no interpolation); only a command that genuinely needs shell features goes
 *    through the single controlled `/bin/sh -c` layer (residual risk: an
 *    operator who can already run a shell command through their build).
 */
@Injectable()
export class ScanBuildAdapterService {
  private readonly runsDir = process.env.RUNS_DIR || './runs';
  private readonly scanBuildBin = process.env.SCAN_BUILD_BIN || 'scan-build';

  constructor() {
    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true });
    }
  }

  /**
   * Canonical workspace sandbox: WORKSPACE_ROOT env, else /workspace when it
   * exists (docker-compose mounts scanned repos under /workspace), else null —
   * host dev where the operator is the local user and there is no sandbox to
   * enforce (containment would reject every legit scan target outside this
   * package's cwd).
   */
  private workspaceRoot(): string | null {
    const explicit = (process.env.WORKSPACE_ROOT || '').trim();
    if (explicit) return resolve(explicit);
    if (existsSync('/workspace')) return '/workspace';
    return null;
  }

  /**
   * Canonicalize `p` (collapse `..`/`.`) and, when a sandbox root is defined,
   * require it (symlinks followed) to land inside that root. Throws on escape —
   * the same containment as dynamic-analyzer's path-guard.ts (Wave 1).
   */
  private assertInsideWorkspace(p: string): string {
    const root = this.workspaceRoot();
    const abs = resolve(p);
    if (root === null) return abs; // host dev: local operator, full-FS trusted
    const rootReal = realpathSync(root); // throws → misconfigured WORKSPACE_ROOT
    let cur = abs;
    const tail: string[] = [];
    while (!existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) break;
      tail.unshift(basename(cur));
      cur = parent;
    }
    const real = realpathSync(cur); // canonicalizes symlinks in every existing prefix
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw new Error(`scan-build projectPath escapes workspace root (${rootReal}): ${p}`);
    }
    return tail.length ? join(real, ...tail) : real;
  }

  /** getReport runIds are server-generated (`sb_<ts>`); anything else is rejected
   * before it reaches the filesystem. */
  private assertValidRunId(runId: string): void {
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(runId)) {
      throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
    }
  }

  async run(projectPath: string, buildCommand: string, timeoutSec?: number) {
    const timeout = timeoutSec || 300;
    const runId = `sb_${Date.now()}`;
    const reportDir = join(this.runsDir, runId);
    // Canonical containment BEFORE any spawn: reject `..`/symlink-out escapes.
    const cwd = this.assertInsideWorkspace(projectPath);

    // scan-build must SEE the build tool to intercept it: `scan-build make …` recognizes
    // make and injects its ccc-analyzer compiler; `scan-build /bin/sh -c "make …"` does
    // NOT — sh hides the tool, so the real compiler runs and scan-build finds nothing.
    // So for a SIMPLE command (no shell metacharacters) we tokenize on whitespace and pass
    // the argv straight through; a command that actually needs shell features keeps the one
    // controlled `/bin/sh -c` layer. Splitting a metachar-free string is injection-safe (no
    // shell interpretation). --keep-going: don't abort the whole pass on a single TU failure.
    const simple = !/[|&;<>$`(){}[\]*?~\n]/.test(buildCommand);
    const buildArgv = simple ? buildCommand.trim().split(/\s+/) : ['/bin/sh', '-c', buildCommand];
    const result = spawnSync(
      this.scanBuildBin,
      ['-o', reportDir, '--keep-going', ...buildArgv],
      { cwd, timeout: timeout * 1000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    // clang analyzer diagnostics go to stderr; merge with stdout so we parse them.
    const output = `${result.stdout || ''}${result.stderr || ''}` || result.error?.message || '';
    this.saveRun(runId, output, projectPath);
    return { success: result.status === 0, runId, output };
  }

  async getReport(runId: string) {
    this.assertValidRunId(runId);
    const filePath = join(this.runsDir, `${runId}.scanbuild.json`);
    if (!existsSync(filePath)) {
      return {
        report: '',
        findings: [],
      };
    }

    const record = JSON.parse(readFileSync(filePath, 'utf-8'));
    return {
      report: record.output || '',
      findings: record.findings || [],
    };
  }

  private saveRun(runId: string, output: string, projectPath?: string) {
    const findings = this.parseFindings(output, projectPath);
    writeFileSync(
      join(this.runsDir, `${runId}.scanbuild.json`),
      JSON.stringify({ runId, output, findings }, null, 2),
    );
  }

  private parseFindings(output: string, projectPath?: string) {
    const findings: Array<Record<string, unknown>> = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Only Clang Static Analyzer reports — skip plain build chatter.
      if (!/warning:|error:/i.test(line)) continue;

      const match = line.match(/(?<file>[\w./-]+\.(?:c|cc|cpp|cxx|h|hh|hpp)):(?<line>\d+)(?::\d+)?/);
      if (!match?.groups) continue;

      let file = match.groups.file;
      // scan-build runs with cwd=projectPath, so absolute paths share that
      // prefix. Strip it so the basename/endsWith match against candidate
      // file paths (relative to the repo root) works downstream.
      if (projectPath && file.startsWith(projectPath)) {
        file = file.slice(projectPath.length).replace(/^\/+/, '');
      }
      file = file.replace(/^\.\//, '');

      findings.push({
        id: `scanbuild-${findings.length + 1}`,
        file_path: file,
        line_number: Number(match.groups.line),
        function_name: this.extractFunctionName(line),
        allocation_type: 'unknown',
        confidence: /high/i.test(line) ? 'high' : /low/i.test(line) ? 'low' : 'medium',
        context: line.trim(),
      });
    }

    return findings;
  }

  private extractFunctionName(line: string): string {
    const fnMatch = line.match(/\b(?:in|function)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    return fnMatch?.[1] || 'unknown';
  }
}
