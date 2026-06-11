import { Injectable } from '@nestjs/common';
import { runConfined } from './safe-exec';

@Injectable()
export class BinaryRunnerService {
  async run(
    binaryPath: string,
    args: string[],
    timeoutSec?: number,
  ) {
    // No shell + resource-confined: this runs an untrusted compiled binary.
    const result = await runConfined(binaryPath, args ?? [], { timeoutSec: timeoutSec || 60 });
    return {
      success: result.code === 0 && !result.timedOut,
      stdout: result.stdout,
      stderr: result.timedOut ? `${result.stderr}\n[killed: exceeded ${timeoutSec || 60}s / resource limit]` : result.stderr,
      exitCode: result.code,
    };
  }
}
