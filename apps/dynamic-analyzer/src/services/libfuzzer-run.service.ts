/**
 * Runs a harness binary compiled with `-fsanitize=fuzzer,address` for a short,
 * BOUNDED time budget instead of a single fixed input — the escalation tier for a
 * harness whose single-shot (LLM-chosen) input ran clean but the bundle is still
 * borderline. Same execution/parsing spine as `LsanService`/`AsanService`
 * (`runConfined` + `ResultParserService.parseLsanOutput`, which already falls back to
 * `parseAsanOutput` for a combined ASan+LSan build) — libFuzzer binaries report leaks
 * the same way at exit, just after driving many inputs instead of zero.
 */

import { Injectable } from '@nestjs/common';
import { RunManagerService } from './run-manager.service';
import { ResultParserService } from './result-parser.service';
import { runConfined, sanitizeRunId } from './safe-exec';
import { assertExecutablePath } from './path-guard';

@Injectable()
export class LibfuzzerRunService {
  constructor(
    private readonly runManager: RunManagerService,
    private readonly resultParser: ResultParserService,
  ) {}

  async run(binaryPath: string, maxTotalTimeSec: number, timeoutSec?: number) {
    const runId = sanitizeRunId(`fuzz_${Date.now()}`, 'fuzz');
    const budget = Math.max(1, Math.floor(maxTotalTimeSec || 15));
    const timeout = timeoutSec || budget + 30;

    // WORKSPACE_ROOT / RUNS_DIR containment (SECURITY.md): a caller-supplied
    // binaryPath must not point at an arbitrary host executable.
    let canonicalBinary: string;
    try {
      canonicalBinary = assertExecutablePath(binaryPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, runId, findings: [], rawOutput: msg };
    }

    const args = [`-max_total_time=${budget}`, '-runs=-1', '-close_fd_mask=3'];
    const result = await runConfined(canonicalBinary, args, {
      timeoutSec: timeout,
      env: { ...process.env, LSAN_OPTIONS: 'verbosity=1:log_threads=1', ASAN_OPTIONS: 'detect_leaks=1' },
      unlimitedAddressSpace: true,
    });
    const output = result.stderr || result.stdout;
    const findings = this.resultParser.parseLsanOutput(output);

    this.runManager.saveRun(runId, { tool: 'libfuzzer', binaryPath: canonicalBinary, output, findings, success: true });

    return { success: true, runId, findings, rawOutput: output };
  }
}
