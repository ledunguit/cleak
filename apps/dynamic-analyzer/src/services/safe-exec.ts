/**
 * Safe execution of UNTRUSTED compiled binaries. The dynamic analyzer runs code
 * from whatever repository is under scan, so two rules are non-negotiable here:
 *
 *  1. No shell. We use execFile with an argv array — never a interpolated command
 *     string — so a binary path or argument containing `;`, `$(…)`, backticks,
 *     etc. is passed verbatim to the program and cannot inject shell commands.
 *  2. Resource confinement. On Linux we wrap the target in a `bash -c` that sets
 *     ulimits (CPU time, address space, file size, process count) before
 *     `exec`-ing it, so a fork-bomb / runaway-alloc / infinite loop in a
 *     malicious testcase is bounded instead of taking down the host. The wrapper
 *     command is a STATIC template; the binary + args are positional ($@), so
 *     this adds no injection surface. Network isolation needs a sandbox/container
 *     and is out of scope for the host runner (use the Docker build/run path).
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import { Logger } from '@nestjs/common';
import { ServerEventName } from '@cleak/common/mcp/server-events';

const logger = new Logger('safe-exec');

export interface ConfinedResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface ConfinedOptions {
  timeoutSec?: number;
  maxBufferBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * ASan/LSan (and Valgrind) reserve a HUGE *virtual* address space (~20 TB of
   * shadow memory). The default `ulimit -v` (address-space) cap makes the sanitizer
   * allocator abort at startup — `LeakSanitizer: CHECK failed: …kSpaceBeg…` — before
   * it can report anything, so a confined sanitizer run silently finds 0 leaks. Set
   * this for instrumented runs to drop ONLY the `-v` cap; CPU-time, file-size and
   * process-count limits stay, and physical RSS is still bounded by the container's
   * memory. No effect on ordinary (non-instrumented) binary runs.
   */
  unlimitedAddressSpace?: boolean;
}

/** Run id usable in a filesystem path — strip everything but word chars. */
export function sanitizeRunId(id: string, fallbackPrefix = 'run'): string {
  const clean = (id || '').replace(/[^A-Za-z0-9_]/g, '');
  return clean.length ? clean : `${fallbackPrefix}_unknown`;
}

export const intEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};

/**
 * Bound how many `runConfined` calls (Valgrind/ASan/LSan/binary runs) execute
 * simultaneously. Unlike the static-analyzer's tree-sitter parse, `execFile`
 * here is already async/non-blocking for Node's own event loop — the risk
 * isn't event-loop serialization, it's the container's shared CPU/RAM getting
 * thrashed by too many concurrent child processes (ASan/LSan runs additionally
 * disable the address-space ulimit, see `unlimitedAddressSpace` above, which
 * makes unbounded concurrency an overcommit risk with no other guard rail —
 * `docker-compose.yml` sets no memory/cpu limits on this container either).
 * `DYNAMIC_MAX_CONCURRENT_RUNS` env-tunable, default leaves headroom since
 * Valgrind alone can be far heavier per-process than the native binary.
 */
const maxConcurrentRuns = intEnv('DYNAMIC_MAX_CONCURRENT_RUNS', Math.max(1, Math.floor(os.cpus().length / 2)));
let activeRuns = 0;
const waitQueue: (() => void)[] = [];

function acquireRunSlot(): Promise<void> {
  if (activeRuns < maxConcurrentRuns) {
    activeRuns++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseRunSlot(): void {
  const next = waitQueue.shift();
  if (next) {
    next(); // hand the slot directly to the next waiter; activeRuns stays the same
  } else {
    activeRuns--;
  }
}

/**
 * Build the `bash -c` ulimit wrapper argv (Linux only). Limits are env-tunable:
 *   DYNAMIC_ULIMIT_AS_KB   address space   (default 2 GiB)
 *   DYNAMIC_ULIMIT_FSIZE_KB max file size  (default 256 MiB)
 *   DYNAMIC_ULIMIT_NPROC    process count  (default 512, anti fork-bomb)
 * CPU-time limit tracks the wall timeout + a small slack. Disable with
 * DYNAMIC_ULIMIT=off.
 */
function confine(bin: string, args: string[], cpuSec: number, unlimitedAS = false): { cmd: string; argv: string[] } {
  if (process.platform !== 'linux' || process.env.DYNAMIC_ULIMIT === 'off') {
    return { cmd: bin, argv: args };
  }
  const asKb = intEnv('DYNAMIC_ULIMIT_AS_KB', 2 * 1024 * 1024);
  const fsizeKb = intEnv('DYNAMIC_ULIMIT_FSIZE_KB', 256 * 1024);
  const nproc = intEnv('DYNAMIC_ULIMIT_NPROC', 512);
  const t = Math.max(1, Math.floor(cpuSec));
  // Sanitizer/Valgrind runs need an UNLIMITED virtual address space (see ConfinedOptions).
  const vLimit = unlimitedAS ? 'unlimited' : String(asKb);
  // Static template — bin/args arrive as "$@" ($0 is the throwaway "_").
  const script = `ulimit -t ${t} -v ${vLimit} -f ${fsizeKb} -u ${nproc} 2>/dev/null; exec "$@"`;
  return { cmd: 'bash', argv: ['-c', script, '_', bin, ...args] };
}

/**
 * Execute a binary without a shell, confined, capturing stdout/stderr even on a
 * non-zero exit (sanitizers report leaks via a non-zero exit + stderr). Never
 * throws for process-level failures — returns the captured streams + exit code.
 */
export async function runConfined(binaryPath: string, args: string[], opts: ConfinedOptions = {}): Promise<ConfinedResult> {
  await acquireRunSlot();
  const startedAt = Date.now();
  try {
    const timeoutSec = opts.timeoutSec ?? 120;
    const { cmd, argv } = confine(binaryPath, args ?? [], timeoutSec + 5, opts.unlimitedAddressSpace);
    logger.log(
      { event: ServerEventName.EXEC_CONFINED_STARTED, binaryPath, argCount: args?.length ?? 0, timeoutSec, unlimitedAddressSpace: !!opts.unlimitedAddressSpace },
      'confined exec started',
    );
    const result = await new Promise<ConfinedResult>((resolve) => {
      execFile(
        cmd,
        argv,
        {
          timeout: timeoutSec * 1000,
          maxBuffer: opts.maxBufferBytes ?? 10 * 1024 * 1024,
          encoding: 'utf-8',
          env: opts.env ?? process.env,
          cwd: opts.cwd,
          killSignal: 'SIGKILL',
        },
        (err: any, stdout: string, stderr: string) => {
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: typeof err?.code === 'number' ? err.code : 0,
            timedOut: err?.killed === true || err?.signal === 'SIGKILL' || err?.signal === 'SIGTERM',
          });
        },
      );
    });
    logger.log(
      { event: ServerEventName.EXEC_CONFINED_FINISHED, binaryPath, exitCode: result.code, timedOut: result.timedOut, durationMs: Date.now() - startedAt },
      'confined exec finished',
    );
    return result;
  } finally {
    releaseRunSlot();
  }
}
