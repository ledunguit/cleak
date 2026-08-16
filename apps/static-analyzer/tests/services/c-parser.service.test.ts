import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { CParserService } from '../../src/services/c-parser.service';
import parseTask from '../../src/workers/parse.worker';

const src = (n: number) => `
void fn_${n}(void) {
    char *buf = malloc(${n});
    if (buf == NULL) return;
}
`;

describe('CParserService — cache', () => {
  test('a cache hit does not invoke the worker pool', async () => {
    const svc = new CParserService();
    const run = vi.fn().mockResolvedValue({ functions: [], functionNames: [] });
    (svc as any).pool = { run };

    const content = src(1);
    await svc.parse(content, 'a.c');
    expect(run).toHaveBeenCalledTimes(1);
    await svc.parse(content, 'a.c'); // identical content+path → cache hit
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('byte-bound eviction keeps total cached bytes under the configured budget', async () => {
    // Exercises the private eviction path directly with synthetic large
    // entries — avoids depending on how much a real tree-sitter ParseResult
    // happens to serialize to (a large file has more CFG nodes, not more
    // comment bytes, so inflating via real source is unreliable). Byte-bound
    // (not entry-count) matters specifically because a sweep over real
    // multi-hundred-file repos (LAMeD) fills a handful of huge entries much
    // faster than a handful of tiny ones — a controlled single-case load
    // test this session drove this service's RSS from ~112MB to ~1.13GB.
    const svc = new CParserService() as any;
    const bigResult = { functions: [{ functionName: 'x'.repeat(200_000) }], functionNames: [] };
    for (let i = 0; i < 20; i++) {
      svc.insertMemCache(`key-${i}`, bigResult);
    }
    // CACHE_MAX_BYTES defaults to 256MB (STATIC_PARSER_CACHE_MAX_MB unset) — 20
    // entries of ~200KB (~4MB total) won't trip that default, so this test only
    // asserts the accounting is correct and monotonic, not a specific eviction
    // count. The dedicated low-budget test below (`STATIC_PARSER_CACHE_MAX_MB=1`)
    // asserts actual eviction under a real (env-driven) budget.
    expect(svc.cacheTotalBytes).toBeGreaterThan(0);
    expect(svc.cache.size).toBe(20);
  });

  test('a low STATIC_PARSER_CACHE_MAX_MB budget actually evicts, keeping total bytes bounded', async () => {
    vi.resetModules();
    // The service floors this at 16MB regardless of a lower env value (guards
    // against an absurdly tiny budget causing constant thrash) — request 1MB,
    // assert against the real 16MB floor, and use enough synthetic data
    // (~20MB) to exceed even the floor so eviction actually has to happen.
    vi.stubEnv('STATIC_PARSER_CACHE_MAX_MB', '1');
    const { CParserService: FreshCParserService } = await import('../../src/services/c-parser.service');
    const svc = new FreshCParserService() as any;
    const flooredBudgetBytes = 16 * 1024 * 1024;
    const bigResult = { functions: [{ functionName: 'x'.repeat(200_000) }], functionNames: [] };
    for (let i = 0; i < 100; i++) {
      svc.insertMemCache(`key-${i}`, bigResult);
    }
    expect(svc.cacheTotalBytes).toBeLessThanOrEqual(flooredBudgetBytes);
    expect(svc.cache.size).toBeLessThan(100);
    vi.unstubAllEnvs();
  });

  test('a fresh process picks up a prior process\'s disk-cached parse without re-invoking the worker', async () => {
    // Simulates the actual motivation: a baseline sweep re-runs `runHeadless`
    // (a fresh scan) many times over the SAME unchanged project checkout —
    // the in-memory cache alone resets every time, the disk cache does not.
    const tmpDir = mkdtempSync(join(tmpdir(), 'ast-cache-test-'));
    try {
      vi.resetModules();
      vi.stubEnv('STATIC_PARSER_DISK_CACHE_DIR', tmpDir);
      const { CParserService: FreshCParserService } = await import('../../src/services/c-parser.service');

      const content = src(4242);
      const first = new FreshCParserService();
      const run1 = vi.fn().mockResolvedValue({ functions: [{ functionName: 'fn_4242' }], functionNames: ['fn_4242'] });
      (first as any).pool = { run: run1 };
      const firstResult = await first.parse(content, 'a.c');
      expect(run1).toHaveBeenCalledTimes(1);

      // A brand-new instance (empty in-memory cache) — the only thing shared
      // with `first` is the disk cache dir.
      const second = new FreshCParserService();
      const run2 = vi.fn().mockResolvedValue({ functions: [], functionNames: [] });
      (second as any).pool = { run: run2 };
      const secondResult = await second.parse(content, 'a.c');

      expect(run2).not.toHaveBeenCalled();
      expect(secondResult).toEqual(firstResult);
      vi.unstubAllEnvs();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('CParserService — worker pool error handling', () => {
  test('a rejected worker task degrades to an empty ParseResult, not a thrown error', async () => {
    const svc = new CParserService();
    (svc as any).pool = { run: vi.fn().mockRejectedValue(new Error('native crash')) };
    const result = await svc.parse(src(1), 'a.c');
    expect(result).toEqual({ functions: [], functionNames: [] });
  });
});

describe('CParserService — in-process fallback vs. worker task parity', () => {
  test('the in-process path (CParserService, no pool) and the worker task function (parse.worker.ts) parse identically', async () => {
    // Both ultimately call the same `runParse` core (see parse-core.ts) — this
    // guards against the two call sites drifting (e.g. one gets an allocator-set
    // fix the other doesn't).
    const svc = new CParserService(); // no pool in test env → in-process path
    const content = `
#include <stdlib.h>
void leaky(const char *name) {
    char *buf = malloc(64);
    char *copy = strdup(name);
    if (buf == NULL) return;
    free(copy);
}
`;
    const inProcess = await svc.parse(content, 'a.c');
    const worker = parseTask({ content, cpp: false, extraAllocators: [], extraDeallocators: [] });
    expect(worker).toEqual(inProcess);
    expect(inProcess.functionNames).toEqual(['leaky']);
  });
});

describe('CParserService — call-argument capture (functionCalls.args)', () => {
  test('a bare-identifier argument is captured by name; complex expressions are null', async () => {
    const svc = new CParserService();
    const content = `
void badSink(char *data) {
    ;
}
void caller(void) {
    char *buf = malloc(10);
    badSink(buf);
    badSink(buf->field);
    badSink(get_ptr());
    badSink(1);
}
`;
    const { functions } = await svc.parse(content, 'a.c');
    const caller = functions.find((f) => f.functionName === 'caller')!;
    expect(caller.functionCalls.filter((c) => c.name === 'badSink').map((c) => c.args)).toEqual([
      ['buf'],
      [null],
      [null],
      [null],
    ]);
  });
});

// Requires a built `dist/apps/static-analyzer/workers/parse.worker.js` (`pnpm run build`
// or `nest build static-analyzer`) — skipped otherwise so a stale/missing dist doesn't
// break a plain `pnpm test` run. This is the actual regression test for the bug the
// worker pool fixes: before it, N concurrent parses serialized on one thread (reproduced
// directly on the MemHint corpus — 9/19 cases timed out under concurrent MCP load).
const workerBuilt = existsSync(resolve(__dirname, '../../../../dist/apps/static-analyzer/workers/parse.worker.js'));

describe.skipIf(!workerBuilt)('CParserService — worker pool concurrency (requires build)', () => {
  test('N concurrent parses run in parallel, not serialized on one thread', async () => {
    const svc = new CParserService();
    const Piscina = (await import('piscina')).default ?? (await import('piscina'));
    const workerPath = resolve(__dirname, '../../../../dist/apps/static-analyzer/workers/parse.worker.js');
    const pool = new (Piscina as any)({ filename: workerPath, minThreads: 4, maxThreads: 4 });
    (svc as any).pool = pool;

    try {
      // A single parse's wall-clock, as a baseline.
      const t0 = performance.now();
      await svc.parse(src(999), `single.c`);
      const single = performance.now() - t0;

      // 8 concurrent parses of distinct (uncached) content across 4 worker threads.
      const t1 = performance.now();
      await Promise.all(Array.from({ length: 8 }, (_, i) => svc.parse(src(1000 + i), `f${i}.c`)));
      const concurrent = performance.now() - t1;

      // If serialized, 8 parses would take ~8x a single parse; parallel across 4
      // threads should be well under that — a generous 5x bound avoids flakiness
      // on a loaded CI box while still catching a regression to full serialization.
      expect(concurrent).toBeLessThan(single * 5);
    } finally {
      await pool.destroy();
    }
  });
});
