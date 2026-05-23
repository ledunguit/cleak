import { Injectable } from '@nestjs/common';
import { execSync } from 'child_process';
import { RunManagerService } from './run-manager.service';
import { ResultParserService } from './result-parser.service';

@Injectable()
export class LsanService {
  constructor(
    private readonly runManager: RunManagerService,
    private readonly resultParser: ResultParserService,
  ) {}

  async run(
    binaryPath: string,
    args: string[],
    timeoutSec?: number,
  ) {
    const runId = `lsan_${Date.now()}`;
    const timeout = timeoutSec || 120;

    try {
      const output = execSync(
        `${binaryPath} ${args.join(' ')}`,
        {
          timeout: timeout * 1000,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, LSAN_OPTIONS: 'verbosity=1:log_threads=1' },
        },
      );

      const findings = this.resultParser.parseLsanOutput(output);

      this.runManager.saveRun(runId, {
        tool: 'lsan',
        binaryPath,
        output,
        findings,
        success: true,
      });

      return {
        success: true,
        runId,
        findings,
        rawOutput: output,
      };
    } catch (err: any) {
      const stderr = err.stderr || '';
      const findings = this.resultParser.parseLsanOutput(stderr);

      this.runManager.saveRun(runId, {
        tool: 'lsan',
        binaryPath,
        output: stderr,
        findings,
        success: true,
      });

      return {
        success: true,
        runId,
        findings,
        rawOutput: stderr,
      };
    }
  }
}
