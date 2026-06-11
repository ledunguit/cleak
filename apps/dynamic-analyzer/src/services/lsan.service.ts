import { Injectable } from '@nestjs/common';
import { RunManagerService } from './run-manager.service';
import { ResultParserService } from './result-parser.service';
import { runConfined, sanitizeRunId } from './safe-exec';

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
    const runId = sanitizeRunId(`lsan_${Date.now()}`, 'lsan');
    const timeout = timeoutSec || 120;

    // No shell; confined. LeakSanitizer reports on stderr and exits non-zero on a leak.
    const result = await runConfined(binaryPath, args ?? [], {
      timeoutSec: timeout,
      env: { ...process.env, LSAN_OPTIONS: 'verbosity=1:log_threads=1' },
    });
    const output = result.stderr || result.stdout;
    const findings = this.resultParser.parseLsanOutput(output);

    this.runManager.saveRun(runId, { tool: 'lsan', binaryPath, output, findings, success: true });

    return { success: true, runId, findings, rawOutput: output };
  }
}
