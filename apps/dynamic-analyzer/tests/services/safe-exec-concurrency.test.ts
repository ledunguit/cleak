import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// `runConfined`'s concurrency limit (`maxConcurrentRuns`) is computed ONCE at
// module load from `DYNAMIC_MAX_CONCURRENT_RUNS` — set the env var and
// `vi.resetModules()` BEFORE importing so each test gets a fresh module
// instance bound to its own limit, instead of sharing one process-wide value.
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

describe('runConfined — concurrency limiter', () => {
  const prevEnv = process.env.DYNAMIC_MAX_CONCURRENT_RUNS;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.DYNAMIC_MAX_CONCURRENT_RUNS;
    else process.env.DYNAMIC_MAX_CONCURRENT_RUNS = prevEnv;
  });

  test('never runs more than DYNAMIC_MAX_CONCURRENT_RUNS execFile calls at once', async () => {
    process.env.DYNAMIC_MAX_CONCURRENT_RUNS = '2';
    const { runConfined } = await import('../../src/services/safe-exec');

    let active = 0;
    let peak = 0;
    mockExecFile.mockImplementation((_cmd: string, _argv: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        cb(null, '', '');
      }, 20);
    });

    // 4 concurrent requests against a limit of 2.
    await Promise.all([
      runConfined('/bin/true', []),
      runConfined('/bin/true', []),
      runConfined('/bin/true', []),
      runConfined('/bin/true', []),
    ]);

    expect(mockExecFile).toHaveBeenCalledTimes(4);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2); // sanity: the limiter isn't accidentally serializing to 1
  });

  test('a released slot is handed to the next queued call (no starvation)', async () => {
    process.env.DYNAMIC_MAX_CONCURRENT_RUNS = '1';
    const { runConfined } = await import('../../src/services/safe-exec');

    let calls = 0;
    mockExecFile.mockImplementation((_cmd: string, _argv: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      calls++;
      setTimeout(() => cb(null, '', ''), 5);
    });

    await Promise.all([runConfined('/bin/true', []), runConfined('/bin/true', []), runConfined('/bin/true', [])]);
    expect(calls).toBe(3); // all 3 eventually ran, none stuck waiting forever
  });
});
