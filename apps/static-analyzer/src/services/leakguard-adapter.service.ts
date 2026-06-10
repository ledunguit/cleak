import { Injectable } from '@nestjs/common';
import { execSync } from 'child_process';
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
 * findings. Kept under the historical `leakguard` tool id so the proto/MCP/UI
 * "deep static" slot is unchanged.
 */
@Injectable()
export class LeakGuardAdapterService {
  private readonly runsDir = process.env.RUNS_DIR || './runs';
  private readonly scanBuildBin = process.env.SCAN_BUILD_BIN || 'scan-build';

  constructor() {
    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true });
    }
  }

  async run(projectPath: string, buildCommand: string, timeoutSec?: number) {
    const timeout = timeoutSec || 300;
    const runId = `lg_${Date.now()}`;
    const reportDir = join(this.runsDir, runId);
    const escaped = buildCommand.replace(/"/g, '\\"');

    try {
      // --keep-going: don't abort the whole pass on a single TU failure.
      // 2>&1: clang analyzer diagnostics go to stderr; merge so we parse them.
      const output = execSync(
        `${this.scanBuildBin} -o "${reportDir}" --keep-going /bin/sh -c "${escaped}" 2>&1`,
        {
          cwd: projectPath,
          timeout: timeout * 1000,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      this.saveRun(runId, output, projectPath);
      return { success: true, runId, output };
    } catch (err: any) {
      const output = `${err.stdout || ''}${err.stderr || ''}` || err.message || '';
      this.saveRun(runId, output, projectPath);
      return { success: false, runId, output };
    }
  }

  async getReport(runId: string) {
    const filePath = join(this.runsDir, `${runId}.leakguard.json`);
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
      join(this.runsDir, `${runId}.leakguard.json`),
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
        id: `leakguard-${findings.length + 1}`,
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
