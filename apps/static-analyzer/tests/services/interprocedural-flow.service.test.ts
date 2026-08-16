import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CParserService } from '../../src/services/c-parser.service';
import { InterproceduralFlowService } from '../../src/services/interprocedural-flow.service';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleak-ipf-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('InterproceduralFlowService — reachability trace', () => {
  test('traces the call chain from the start function (DFS pre-order), collecting frees and reconciling same-named vars', async () => {
    const a = write(
      'trace.c',
      `
#include <stdlib.h>
void sink(char *x) {
    free(x);
}
void entry(void) {
    char *x = malloc(8);
    sink(x);
}
`,
    );

    const svc = new InterproceduralFlowService(new CParserService());
    const result = await svc.analyze(dir, 'entry', [a]);

    expect(result.paths.map((p) => p.functionName)).toEqual(['entry', 'sink']);
    expect(result.depth).toBe(2);
    // leading newline in the template → sink's body `free(x)` is on line 4
    expect(result.reachableFrees).toEqual([`free at ${a}:4`]);
    // x is freed by the reachable sink (name-matched) → NOT unreconciled
    expect(result.unreconciledAllocVars).toEqual([]);
  });

  test('an allocation freed nowhere reachable is reported as unreconciled', async () => {
    const a = write(
      'leak.c',
      `
#include <stdlib.h>
void entry(void) {
    char *x = malloc(8);
}
`,
    );

    const svc = new InterproceduralFlowService(new CParserService());
    const result = await svc.analyze(dir, 'entry', [a]);

    expect(result.paths.map((p) => p.functionName)).toEqual(['entry']);
    expect(result.unreconciledAllocVars).toEqual(['x']);
    expect(result.hasLeak).toBe(true);
  });
});

describe('InterproceduralFlowService — parseCache is bounded', () => {
  test('parseCache does not grow without bound across many distinct files', async () => {
    // Regression test: this service is a long-lived DI singleton, so an
    // unbounded parseCache accumulates one entry per DISTINCT file ever seen
    // across every case a process handles — confirmed directly: a 15-case
    // batch across several real projects drove the container's RSS from
    // ~105MB to its 4GB ceiling with no plateau, even with
    // CParserService's own cache separately byte-bounded (Phase 2). Uses
    // nonexistent file paths — parseFile's own read-error fallback still
    // exercises the cache-size/eviction path without needing real files.
    const svc = new InterproceduralFlowService(new CParserService()) as any;
    for (let i = 0; i < 5000; i++) {
      await svc.parseFile(`/nonexistent-${i}.c`, i, [], []);
    }
    expect(svc.parseCache.size).toBeLessThanOrEqual(4096);
  });
});

describe('InterproceduralFlowService — reachability memoization', () => {
  test('repeated analyze() over unchanged inputs returns byte-identical results from the cache', async () => {
    const a = write(
      'memo.c',
      `
#include <stdlib.h>
void sink(char *x) {
    free(x);
}
void entry(void) {
    char *x = malloc(8);
    sink(x);
}
`,
    );

    const svc = new InterproceduralFlowService(new CParserService());
    const first = await svc.analyze(dir, 'entry', [a]);
    const second = await svc.analyze(dir, 'entry', [a]);

    expect(second).toEqual(first);
    // one key per (start function, file fingerprint) — the second call reuses it
    expect((svc as unknown as { reachabilityCache: Map<string, unknown> }).reachabilityCache.size).toBe(1);
  });

  test('changing a file (new mtime) invalidates the cache: the recomputed walk reflects the new content', async () => {
    const a = write(
      'invalidate.c',
      `
#include <stdlib.h>
void sink(char *x) {
    free(x);
}
void entry(void) {
    char *x = malloc(8);
    sink(x);
}
`,
    );

    const svc = new InterproceduralFlowService(new CParserService());
    const before = await svc.analyze(dir, 'entry', [a]);
    expect(before.unreconciledAllocVars).toEqual([]);

    // Force a distinct mtime, then grow the trace with an unfreed allocation.
    const now = Date.now() / 1000;
    utimesSync(a, now, now);
    writeFileSync(
      a,
      `
#include <stdlib.h>
void sink(char *x) {
    free(x);
}
void entry(void) {
    char *x = malloc(8);
    char *y = malloc(8);
    sink(x);
}
`,
      'utf-8',
    );

    const after = await svc.analyze(dir, 'entry', [a]);
    expect(after.unreconciledAllocVars).toEqual(['y']);
    expect(after).not.toEqual(before);
  });

  test('different start functions are not confused by the cache', async () => {
    const a = write(
      'distinct.c',
      `
#include <stdlib.h>
void clean(void) {
    char *x = malloc(8);
    free(x);
}
void leaky(void) {
    char *x = malloc(8);
}
`,
    );

    const svc = new InterproceduralFlowService(new CParserService());
    const clean = await svc.analyze(dir, 'clean', [a]);
    const leaky = await svc.analyze(dir, 'leaky', [a]);

    expect(clean.unreconciledAllocVars).toEqual([]);
    expect(leaky.unreconciledAllocVars).toEqual(['x']);
  });
});
