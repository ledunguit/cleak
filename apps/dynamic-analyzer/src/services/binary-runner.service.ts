import { Injectable } from '@nestjs/common';
import { runConfined } from './safe-exec';
import { assertExecutablePath } from './path-guard';

@Injectable()
export class BinaryRunnerService {
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
      return { success: false, stdout: '', stderr: msg, exitCode: -1 };
    }
    // No shell + resource-confined: this runs an untrusted compiled binary.
    const result = await runConfined(canonicalBinary, args ?? [], { timeoutSec: timeoutSec || 60 });
    return {
      success: result.code === 0 && !result.timedOut,
      stdout: result.stdout,
      stderr: result.timedOut ? `${result.stderr}\n[killed: exceeded ${timeoutSec || 60}s / resource limit]` : result.stderr,
      exitCode: result.code,
    };
  }
}
