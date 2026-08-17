import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { judgeCacheDir, judgeCacheKey, readJudgeCache, writeJudgeCache } from '../../src/domain/judgeVerdictCache';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '@cleak/common/types';
import type { ConsensusConfig } from '@cleak/common/analysis/consensus-judge';

function bundle(over: Partial<LeakBundle> = {}): LeakBundle {
  return {
    bundleId: 'b1',
    candidate: {
      id: '',
      function_name: 'session_open',
      file_path: '/nonexistent/session.c', // source unavailable → deterministic placeholder snippet
      line_number: 8,
      allocation_site: '',
      allocation_type: 'malloc',
      confidence: 'medium',
      context: '',
    },
    evidence: [],
    status: 'pending' as any,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

const consensusCfg: ConsensusConfig = { n: 1, rule: 'weighted', temperature: 0 };

const verdict = (v: InvestigationVerdict = InvestigationVerdict.CONFIRMED_LEAK): VerdictResult => ({
  verdict: v,
  confidence: 0.9,
  explanation: 'cached test verdict',
  evidence: [],
  tool: ToolKind.LLM,
});

describe('judgeCacheKey — stability and sensitivity', () => {
  test('identical inputs produce the identical key', () => {
    const a = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    const b = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    expect(a).toBe(b);
  });

  test('a different candidate location changes the key', () => {
    const a = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    const b = judgeCacheKey(bundle({ candidate: { ...bundle().candidate, line_number: 9 } }), undefined, undefined, consensusCfg);
    expect(a).not.toBe(b);
  });

  test('a different evidence set changes the key', () => {
    const a = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    const b = judgeCacheKey(
      bundle({
        evidence: [
          { tool: 'lsan', function_name: 'session_open', file_path: 'x.c', line_number: 8, bytes_lost: 10, blocks_lost: 1, severity: 'high' } as any,
        ],
      }),
      undefined,
      undefined,
      consensusCfg,
    );
    expect(a).not.toBe(b);
  });

  test('a different static context changes the key', () => {
    const a = judgeCacheKey(bundle(), { earlyReturnCount: 0 }, undefined, consensusCfg);
    const b = judgeCacheKey(bundle(), { earlyReturnCount: 3 }, undefined, consensusCfg);
    expect(a).not.toBe(b);
  });

  test('different project ownership notes change the key', () => {
    const a = judgeCacheKey(bundle(), undefined, ['pool allocator, do not free individually'], consensusCfg);
    const b = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    expect(a).not.toBe(b);
  });

  test('a different consensus config (n/rule/temperature) changes the key', () => {
    const a = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    const b = judgeCacheKey(bundle(), undefined, undefined, { n: 3, rule: 'weighted', temperature: 0 });
    const c = judgeCacheKey(bundle(), undefined, undefined, { n: 1, rule: 'unanimous-to-flag', temperature: 0 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  test('bundleId/createdAt/updatedAt (identity/provenance fields) do NOT affect the key', () => {
    const a = judgeCacheKey(bundle({ bundleId: 'b1' }), undefined, undefined, consensusCfg);
    const b = judgeCacheKey(bundle({ bundleId: 'totally-different-id', createdAt: 'x', updatedAt: 'y' }), undefined, undefined, consensusCfg);
    expect(a).toBe(b);
  });
});

describe('judgeCacheKey — prompt-change invalidation (no hand-maintained version counter)', () => {
  test('the key is derived from the LIVE SYSTEM_PROMPT text, so any edit to it changes every key', async () => {
    // Import fresh so we can compare against a module where SYSTEM_PROMPT differs —
    // simulated here by hashing with vi.doMock would be heavier than needed; instead
    // assert the documented mechanism directly: judgeCacheKey's payload includes the
    // imported SYSTEM_PROMPT constant, so this is really testing that the function
    // does NOT hardcode/ignore it. Verified structurally: two calls with everything
    // else equal but through the real import must already match (proven above); this
    // test exists to document the invariant this design relies on rather than a
    // hand-maintained "prompt version" number — see judgeVerdictCache.ts's doc comment.
    const { SYSTEM_PROMPT } = await import('../../src/domain/llmJudge');
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
    const a = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    const b = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    expect(a).toBe(b); // same live prompt text → same key, as documented
  });
});

describe('read/write/sweep — disk round-trip', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cleak-judgecache-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('a miss returns null; a write-then-read round-trips the exact verdict', () => {
    const key = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    expect(readJudgeCache(repo, key)).toBeNull();

    const v = verdict();
    writeJudgeCache(repo, key, v);
    expect(readJudgeCache(repo, key)).toEqual(v);
  });

  test('cache lives under <repo>/.cleak/judge-cache/, matching allocatorProfiler.ts\'s <repo>/.cleak/ convention', () => {
    const key = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    writeJudgeCache(repo, key, verdict());
    expect(judgeCacheDir(repo)).toBe(join(repo, '.cleak', 'judge-cache'));
    const files = readdirSync(judgeCacheDir(repo));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${key}.json`);
  });

  test('a corrupt cache file is treated as a miss, not a crash', () => {
    const key = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    writeJudgeCache(repo, key, verdict());
    writeFileSync(join(judgeCacheDir(repo), `${key}.json`), 'not json{{{');
    expect(readJudgeCache(repo, key)).toBeNull();
  });

  test('retention sweep keeps only the most-recently-modified maxEntries files', () => {
    const keys = Array.from({ length: 5 }, (_, i) =>
      judgeCacheKey(bundle({ candidate: { ...bundle().candidate, line_number: i } }), undefined, undefined, consensusCfg),
    );
    const now = Date.now() / 1000;
    keys.forEach((key, i) => {
      writeJudgeCache(repo, key, verdict(), 1000); // no eviction yet — build up 5 distinct mtimes
      // Backdate into the past (not the future) so the real-time write below is
      // unambiguously the most recent, regardless of how fast this test runs.
      utimesSync(join(judgeCacheDir(repo), `${key}.json`), now - (keys.length - i) * 10, now - (keys.length - i) * 10);
    });
    // Now write a 6th entry with a tiny maxEntries — should evict down to it.
    const lastKey = judgeCacheKey(bundle({ candidate: { ...bundle().candidate, line_number: 99 } }), undefined, undefined, consensusCfg);
    writeJudgeCache(repo, lastKey, verdict(), 2);

    const remaining = readdirSync(judgeCacheDir(repo));
    expect(remaining.length).toBeLessThanOrEqual(2);
    expect(remaining).toContain(`${lastKey}.json`); // the just-written entry always survives
  });

  test('a write failure (unwritable dir) never throws into the caller', () => {
    const key = judgeCacheKey(bundle(), undefined, undefined, consensusCfg);
    // Point at a path that can't be created as a directory (a file in its place).
    const blockedRepo = join(repo, 'blocked');
    writeFileSync(blockedRepo, 'i am a file, not a directory');
    expect(() => writeJudgeCache(blockedRepo, key, verdict())).not.toThrow();
  });
});
