import { Injectable } from '@nestjs/common';
import { RunManagerService } from './run-manager.service';
import { ResultParserService } from './result-parser.service';
import { runConfined, sanitizeRunId } from './safe-exec';

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
    const runId = sanitizeRunId(`asan_${Date.now()}`, 'asan');
    const timeout = timeoutSec || 120;

    // No shell; the binary runs confined. ASan reports leaks on stderr and the
    // binary may exit non-zero — that's still a successful analysis run.
    const result = await runConfined(binaryPath, args ?? [], {
      timeoutSec: timeout,
      env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=1:verbosity=1' },
      unlimitedAddressSpace: true, // ASan reserves ~20 TB virtual — the -v cap aborts it
    });
    const output = result.stderr || result.stdout;
    const findings = this.resultParser.parseAsanOutput(output);

    this.runManager.saveRun(runId, { tool: 'asan', binaryPath, output, findings, success: true });

    return { success: true, runId, findings, rawOutput: output };
  }
}
