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
}

/** Run id usable in a filesystem path — strip everything but word chars. */
export function sanitizeRunId(id: string, fallbackPrefix = 'run'): string {
  const clean = (id || '').replace(/[^A-Za-z0-9_]/g, '');
  return clean.length ? clean : `${fallbackPrefix}_unknown`;
}

const intEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};

/**
 * Build the `bash -c` ulimit wrapper argv (Linux only). Limits are env-tunable:
 *   DYNAMIC_ULIMIT_AS_KB   address space   (default 2 GiB)
 *   DYNAMIC_ULIMIT_FSIZE_KB max file size  (default 256 MiB)
 *   DYNAMIC_ULIMIT_NPROC    process count  (default 512, anti fork-bomb)
 * CPU-time limit tracks the wall timeout + a small slack. Disable with
 * DYNAMIC_ULIMIT=off.
 */
function confine(bin: string, args: string[], cpuSec: number): { cmd: string; argv: string[] } {
  if (process.platform !== 'linux' || process.env.DYNAMIC_ULIMIT === 'off') {
    return { cmd: bin, argv: args };
  }
  const asKb = intEnv('DYNAMIC_ULIMIT_AS_KB', 2 * 1024 * 1024);
  const fsizeKb = intEnv('DYNAMIC_ULIMIT_FSIZE_KB', 256 * 1024);
  const nproc = intEnv('DYNAMIC_ULIMIT_NPROC', 512);
  const t = Math.max(1, Math.floor(cpuSec));
  // Static template — bin/args arrive as "$@" ($0 is the throwaway "_").
  const script = `ulimit -t ${t} -v ${asKb} -f ${fsizeKb} -u ${nproc} 2>/dev/null; exec "$@"`;
  return { cmd: 'bash', argv: ['-c', script, '_', bin, ...args] };
}

/**
 * Execute a binary without a shell, confined, capturing stdout/stderr even on a
 * non-zero exit (sanitizers report leaks via a non-zero exit + stderr). Never
 * throws for process-level failures — returns the captured streams + exit code.
 */
export function runConfined(binaryPath: string, args: string[], opts: ConfinedOptions = {}): Promise<ConfinedResult> {
  const timeoutSec = opts.timeoutSec ?? 120;
  const { cmd, argv } = confine(binaryPath, args ?? [], timeoutSec + 5);
  return new Promise((resolve) => {
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
}
