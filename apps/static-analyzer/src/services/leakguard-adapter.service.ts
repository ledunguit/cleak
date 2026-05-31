import { Injectable } from '@nestjs/common';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

@Injectable()
export class LeakGuardAdapterService {
  private readonly runsDir = process.env.RUNS_DIR || './runs';

  constructor() {
    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true });
    }
  }

  async run(
    projectPath: string,
    buildCommand: string,
    timeoutSec?: number,
  ) {
    const timeout = timeoutSec || 300;
    const runId = `lg_${Date.now()}`;

    try {
      const output = execSync(
        `docker run --rm -v "${projectPath}:/project" leakguard-tool:dev /bin/sh -c "cd /project && ${buildCommand}"`,
        {
          timeout: timeout * 1000,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      this.saveRun(runId, output);

      return {
        success: true,
        runId,
        output,
      };
    } catch (err: any) {
      const output = err.stderr || err.message;
      this.saveRun(runId, output);
      return {
        success: false,
        runId,
        output,
      };
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

  private saveRun(runId: string, output: string) {
    const findings = this.parseFindings(output);
    writeFileSync(
      join(this.runsDir, `${runId}.leakguard.json`),
      JSON.stringify({ runId, output, findings }, null, 2),
    );
  }

  private parseFindings(output: string) {
    const findings: Array<Record<string, unknown>> = [];
    const lines = output.split('\n');

    for (const line of lines) {
      const match = line.match(/(?<file>[\w./-]+\.(?:c|cc|cpp|cxx|h|hh|hpp)):(?<line>\d+)(?::\d+)?/);
      if (!match?.groups) continue;

      findings.push({
        id: `leakguard-${findings.length + 1}`,
        file_path: match.groups.file,
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
