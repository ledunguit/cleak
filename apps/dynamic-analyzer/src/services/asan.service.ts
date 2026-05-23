import { Injectable } from '@nestjs/common';
import { execSync } from 'child_process';
import { RunManagerService } from './run-manager.service';
import { ResultParserService } from './result-parser.service';

@Injectable()
export class AsanService {
  constructor(
    private readonly runManager: RunManagerService,
    private readonly resultParser: ResultParserService,
  ) {}

  async run(
    binaryPath: string,
    args: string[],
    timeoutSec?: number,
  ) {
    const runId = `asan_${Date.now()}`;
    const timeout = timeoutSec || 120;

    try {
      const output = execSync(
        `${binaryPath} ${args.join(' ')}`,
        {
          timeout: timeout * 1000,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=1:verbosity=1' },
        },
      );

      const findings = this.resultParser.parseAsanOutput(output);

      this.runManager.saveRun(runId, {
        tool: 'asan',
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
      const findings = this.resultParser.parseAsanOutput(stderr);

      this.runManager.saveRun(runId, {
        tool: 'asan',
        binaryPath,
        output: stderr,
        findings,
        success: true, // ASan reports leaks via stderr but binary may still exit non-zero
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
