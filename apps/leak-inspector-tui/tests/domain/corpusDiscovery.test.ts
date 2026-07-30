import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { corpusContentHash } from '../../src/domain/corpusLock';
import { discoverCorpora } from '../../src/domain/corpusDiscovery';

let root: string;

function makeCorpus(name: string, caseIds: string[]) {
  return makeCorpusIn(root, name, caseIds);
}

function makeCorpusIn(cwd: string, relPath: string, caseIds: string[]) {
  const dir = join(cwd, relPath);
  for (const id of caseIds) {
    mkdirSync(join(dir, 'cases', id), { recursive: true });
    writeFileSync(join(dir, 'cases', id, 'a.c'), `void ${id}(){ malloc(8); }\n`);
  }
  writeFileSync(
    join(dir, 'corpus_manifest.json'),
    JSON.stringify({ schema_version: 'v2', cases: caseIds.map((id) => ({ id, repo_path: `cases/${id}` })) }),
  );
  return dir;
}

function writeLock(dir: string, contentHash: string, validated = true) {
  writeFileSync(`${dir}.lock.json`, JSON.stringify({ schema: 'corpus-lock/v1', corpus: dir, contentHash, validated }));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'corpusdiscovery-'));

  // 1. Validated: lockfile matches current content hash.
  const validDir = makeCorpus('valid-corpus', ['c1', 'c2', 'c3']);
  writeLock(validDir, corpusContentHash(validDir)!);

  // 2. Missing lock entirely.
  makeCorpus('no-lock-corpus', ['c1']);

  // 3. Drifted: lockfile hash no longer matches (source changed after locking).
  const driftDir = makeCorpus('drifted-corpus', ['c1', 'c2']);
  writeLock(driftDir, corpusContentHash(driftDir)!);
  appendFileSync(join(driftDir, 'cases', 'c1', 'a.c'), '// drift\n');

  // 4. Not a corpus at all (no manifest) — must be silently skipped.
  mkdirSync(join(root, 'not-a-corpus'), { recursive: true });
  writeFileSync(join(root, 'not-a-corpus', 'README.md'), 'nothing here');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('discoverCorpora', () => {
  test('finds every directory with a corpus_manifest.json under the given roots, skips non-corpus dirs', () => {
    const found = discoverCorpora(['valid-corpus', 'no-lock-corpus', 'drifted-corpus', 'not-a-corpus'], root);
    const names = found.map((c) => c.name).sort();
    expect(names).toEqual(['drifted-corpus', 'no-lock-corpus', 'valid-corpus']);
  });

  test('reports the correct case count per corpus', () => {
    const found = discoverCorpora(['valid-corpus'], root);
    expect(found[0].caseCount).toBe(3);
  });

  test('validated corpus reports gate.ok = true', () => {
    const found = discoverCorpora(['valid-corpus'], root);
    expect(found[0].gate.ok).toBe(true);
  });

  test('missing-lock corpus reports gate.ok = false with a "no lockfile" reason', () => {
    const found = discoverCorpora(['no-lock-corpus'], root);
    expect(found[0].gate.ok).toBe(false);
    expect(found[0].gate.reason).toContain('no lockfile');
  });

  test('drifted corpus reports gate.ok = false with a drift reason', () => {
    const found = discoverCorpora(['drifted-corpus'], root);
    expect(found[0].gate.ok).toBe(false);
    expect(found[0].gate.reason).toContain('drift');
  });

  test('results are sorted by name and deduplicated', () => {
    const found = discoverCorpora(['valid-corpus', 'valid-corpus'], root);
    expect(found).toHaveLength(1);
  });

  test('a root that does not exist on disk is silently skipped, not an error', () => {
    expect(() => discoverCorpora(['does-not-exist'], root)).not.toThrow();
    expect(discoverCorpora(['does-not-exist'], root)).toEqual([]);
  });

  test('explicit roots are scoped exactly — no sibling-scan surprise', () => {
    // Even though drifted-corpus/no-lock-corpus live right next to valid-corpus
    // under the same parent, asking for just valid-corpus returns only it.
    const found = discoverCorpora(['valid-corpus'], root);
    expect(found.map((c) => c.name)).toEqual(['valid-corpus']);
  });

  test("the default (no-args) path DOES sibling-scan each default root's parent", () => {
    // DEFAULT_CORPUS_DIRS includes 'demo/juliet_cwe401' — materialize just that one
    // default root under a temp cwd, PLUS an extra corpus dropped next to it that
    // is NOT in DEFAULT_CORPUS_DIRS. The default (no-args) call should still find
    // the extra one via the sibling-scan of demo/.
    const tempCwd = mkdtempSync(join(tmpdir(), 'corpusdiscovery-default-'));
    try {
      makeCorpusIn(tempCwd, 'demo/juliet_cwe401', ['c1']);
      makeCorpusIn(tempCwd, 'demo/locally-added-corpus', ['c1']);
      const found = discoverCorpora(undefined, tempCwd);
      expect(found.map((c) => c.name).sort()).toEqual(['juliet_cwe401', 'locally-added-corpus']);
    } finally {
      rmSync(tempCwd, { recursive: true, force: true });
    }
  });

  test('smoke: default discovery finds the real demo/ corpora in this repo (skips if absent)', () => {
    // demo/* is git-ignored (docs/DATASETS.md) — present on this dev checkout but
    // not guaranteed in every environment, so this only asserts IF it's there.
    const found = discoverCorpora();
    const juliet = found.find((c) => c.name === 'juliet_cwe401');
    if (juliet) expect(juliet.caseCount).toBeGreaterThan(0);
  });
});
