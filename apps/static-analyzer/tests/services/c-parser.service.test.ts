import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

  test('LRU eviction keeps the cache bounded at 512 entries', async () => {
    const svc = new CParserService(); // pool stays null (test env) → in-process fallback
    for (let i = 0; i < 513; i++) {
      await svc.parse(src(i), 'a.c');
    }
    expect((svc as any).cache.size).toBeLessThanOrEqual(512);
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
