import { Injectable } from '@nestjs/common';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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

  async run(projectPath: string, buildCommand: string, timeoutSec?: number) {
    const timeout = timeoutSec || 300;
    const runId = `sb_${Date.now()}`;
    const reportDir = join(this.runsDir, runId);

    // scan-build must SEE the build tool to intercept it: `scan-build make …` recognizes
    // make and injects its ccc-analyzer compiler; `scan-build /bin/sh -c "make …"` does
    // NOT — sh hides the tool, so the real compiler runs and scan-build finds nothing.
    // So for a SIMPLE command (no shell metacharacters) we tokenize on whitespace and pass
    // the argv straight through; a command that actually needs shell features keeps the one
    // controlled `/bin/sh -c` layer. Splitting a metachar-free string is injection-safe (no
    // shell interpretation). --keep-going: don't abort the whole pass on a single TU failure.
    const simple = !/[|&;<>$`(){}\[\]*?~\n]/.test(buildCommand);
    const buildArgv = simple ? buildCommand.trim().split(/\s+/) : ['/bin/sh', '-c', buildCommand];
    const result = spawnSync(
      this.scanBuildBin,
      ['-o', reportDir, '--keep-going', ...buildArgv],
      { cwd: projectPath, timeout: timeout * 1000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    // clang analyzer diagnostics go to stderr; merge with stdout so we parse them.
    const output = `${result.stdout || ''}${result.stderr || ''}` || result.error?.message || '';
    this.saveRun(runId, output, projectPath);
    return { success: result.status === 0, runId, output };
  }

  async getReport(runId: string) {
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
