import { Injectable, Logger } from '@nestjs/common';
import { ServerEventName } from '@cleak/common/mcp/server-events';
import { RunManagerService } from './run-manager.service';
import { ResultParserService } from './result-parser.service';
import { runConfined, sanitizeRunId } from './safe-exec';
import { assertExecutablePath } from './path-guard';

@Injectable()
export class AsanService {
  private readonly logger = new Logger(AsanService.name);

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

    // WORKSPACE_ROOT / RUNS_DIR containment (SECURITY.md): a caller-supplied
    // binaryPath must not point at an arbitrary host executable.
    let canonicalBinary: string;
    try {
      canonicalBinary = assertExecutablePath(binaryPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ event: ServerEventName.SANITIZER_RUN_FAILED, sanitizer: 'asan', runId, err: msg }, 'asan run rejected');
      return { success: false, runId, findings: [], rawOutput: msg };
    }

    const startedAt = Date.now();
    this.logger.log({ event: ServerEventName.SANITIZER_RUN_STARTED, sanitizer: 'asan', runId, binaryPath: canonicalBinary }, 'asan run started');

    // No shell; the binary runs confined. ASan reports leaks on stderr and the
    // binary may exit non-zero — that's still a successful analysis run.
    const result = await runConfined(canonicalBinary, args ?? [], {
      timeoutSec: timeout,
      env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=1:verbosity=1' },
      unlimitedAddressSpace: true, // ASan reserves ~20 TB virtual — the -v cap aborts it
    });
    const output = result.stderr || result.stdout;
    const findings = this.resultParser.parseAsanOutput(output);

    this.runManager.saveRun(runId, { tool: 'asan', binaryPath: canonicalBinary, output, findings, success: true });
    this.logger.log(
      { event: ServerEventName.SANITIZER_RUN_FINISHED, sanitizer: 'asan', runId, durationMs: Date.now() - startedAt, findingCount: findings.length },
      'asan run finished',
    );

    return { success: true, runId, findings, rawOutput: output };
  }
}
