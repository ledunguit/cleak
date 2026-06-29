import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { corpusContentHash, readCorpusLock, checkCorpusGate } from './corpusLock';

let root: string;
let corpusDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'corpuslock-'));
  corpusDir = join(root, 'mini');
  mkdirSync(join(corpusDir, 'cases', 'c1'), { recursive: true });
  writeFileSync(join(corpusDir, 'cases', 'c1', 'a.c'), 'void bad(){ malloc(8); }\n');
  writeFileSync(
    join(corpusDir, 'corpus_manifest.json'),
    JSON.stringify({ schema_version: 'v2', cases: [{ id: 'c1', repo_path: 'cases/c1', flaws: [{ function: 'bad' }] }] }),
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('corpusLock', () => {
  test('content hash is deterministic + changes when a source byte changes', () => {
    const h1 = corpusContentHash(corpusDir);
    expect(h1).toBeTruthy();
    expect(corpusContentHash(corpusDir)).toBe(h1!); // stable
    appendFileSync(join(corpusDir, 'cases', 'c1', 'a.c'), '// drift\n');
    expect(corpusContentHash(corpusDir)).not.toBe(h1);
  });

  test('gate REFUSES when there is no lockfile', () => {
    const g = checkCorpusGate(corpusDir);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('no lockfile');
    expect(g.contentHash).toBeTruthy();
  });

  test('gate PASSES when the lockfile matches the current content hash', () => {
    const hash = corpusContentHash(corpusDir)!;
    writeFileSync(`${corpusDir}.lock.json`, JSON.stringify({ schema: 'corpus-lock/v1', corpus: 'mini', contentHash: hash, validated: true }));
    expect(readCorpusLock(corpusDir)?.contentHash).toBe(hash);
    expect(checkCorpusGate(corpusDir).ok).toBe(true);
  });

  test('gate REFUSES on source drift (lock hash ≠ live hash)', () => {
    writeFileSync(`${corpusDir}.lock.json`, JSON.stringify({ schema: 'corpus-lock/v1', corpus: 'mini', contentHash: 'deadbeef', validated: true }));
    const g = checkCorpusGate(corpusDir);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('drift');
  });

  test('gate REFUSES when the lock records a failed validation', () => {
    const hash = corpusContentHash(corpusDir)!;
    writeFileSync(`${corpusDir}.lock.json`, JSON.stringify({ schema: 'corpus-lock/v1', corpus: 'mini', contentHash: hash, validated: false, summary: { quarantined: 3 } }));
    const g = checkCorpusGate(corpusDir);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('FAILED validation');
  });
});
