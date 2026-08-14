import { Injectable, Logger } from '@nestjs/common';
import { ServerEventName } from '@cleak/common/mcp/server-events';
import { runConfined } from './safe-exec';
import { assertExecutablePath } from './path-guard';

@Injectable()
export class BinaryRunnerService {
  private readonly logger = new Logger(BinaryRunnerService.name);

  async run(
    binaryPath: string,
    args: string[],
    timeoutSec?: number,
  ) {
    // WORKSPACE_ROOT / RUNS_DIR containment (SECURITY.md): a caller-supplied
    // binaryPath must not point at an arbitrary host executable.
    let canonicalBinary: string;
    try {
      canonicalBinary = assertExecutablePath(binaryPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ event: ServerEventName.PATH_REJECTED, binaryPath, err: msg }, 'binary run rejected');
      return { success: false, stdout: '', stderr: msg, exitCode: -1 };
    }
    const startedAt = Date.now();
    this.logger.log({ event: ServerEventName.BINARY_RUN_STARTED, binaryPath: canonicalBinary }, 'binary run started');
    // No shell + resource-confined: this runs an untrusted compiled binary.
    const result = await runConfined(canonicalBinary, args ?? [], { timeoutSec: timeoutSec || 60 });
    this.logger.log(
      { event: ServerEventName.BINARY_RUN_FINISHED, binaryPath: canonicalBinary, exitCode: result.code, timedOut: result.timedOut, durationMs: Date.now() - startedAt },
      'binary run finished',
    );
    return {
      success: result.code === 0 && !result.timedOut,
      stdout: result.stdout,
      stderr: result.timedOut ? `${result.stderr}\n[killed: exceeded ${timeoutSec || 60}s / resource limit]` : result.stderr,
      exitCode: result.code,
    };
  }
}
