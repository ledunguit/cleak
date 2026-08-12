import { Injectable } from '@nestjs/common';
import { RunManagerService } from './run-manager.service';
import { ResultParserService } from './result-parser.service';
import { runConfined, sanitizeRunId } from './safe-exec';
import { assertExecutablePath } from './path-guard';

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

    // WORKSPACE_ROOT / RUNS_DIR containment (SECURITY.md): a caller-supplied
    // binaryPath must not point at an arbitrary host executable.
    let canonicalBinary: string;
    try {
      canonicalBinary = assertExecutablePath(binaryPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, runId, findings: [], rawOutput: msg };
    }

    // No shell; confined. LeakSanitizer reports on stderr and exits non-zero on a leak.
    const result = await runConfined(canonicalBinary, args ?? [], {
      timeoutSec: timeout,
      env: { ...process.env, LSAN_OPTIONS: 'verbosity=1:log_threads=1' },
      unlimitedAddressSpace: true, // ASan/LSan reserve ~20 TB virtual — the -v cap aborts them
    });
    const output = result.stderr || result.stdout;
    const findings = this.resultParser.parseLsanOutput(output);

    this.runManager.saveRun(runId, { tool: 'lsan', binaryPath: canonicalBinary, output, findings, success: true });

    return { success: true, runId, findings, rawOutput: output };
  }
}
