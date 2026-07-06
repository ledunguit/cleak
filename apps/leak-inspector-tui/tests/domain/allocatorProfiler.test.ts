import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CallModel } from '@cleak/agent-core';
import {
  gatherProjectApiText,
  parseAllocatorProfile,
  verifyNames,
  profileAllocators,
} from '../../src/domain/allocatorProfiler';

// A mock model that returns a fixed text (no real LLM). Cast through unknown since we
// only exercise `resp.text`.
const mockModel = (text: string): CallModel =>
  (async () => ({ text, toolUses: [], usage: { inputTokens: 0, outputTokens: 0 } })) as unknown as CallModel;

describe('verifyNames — anti-hallucination + libc filter', () => {
  const src = 'cJSON *cJSON_CreateObject(void); void cJSON_Delete(cJSON *c); cJSON_New_Item(h);';
  test('keeps names present in source, drops hallucinated + libc + dups', () => {
    expect(verifyNames(['cJSON_CreateObject', 'cJSON_New_Item', 'cJSON_Fake', 'malloc', 'cJSON_CreateObject'], src)).toEqual([
      'cJSON_CreateObject',
      'cJSON_New_Item',
    ]);
  });
  test('rejects unsafe identifiers', () => {
    expect(verifyNames(['bad-name', 'ok_name(', '', 'cJSON_Delete'], src)).toEqual(['cJSON_Delete']);
  });
});

describe('parseAllocatorProfile — lenient JSON', () => {
  test('clean JSON', () => {
    const r = parseAllocatorProfile('{"allocators":["a"],"deallocators":["b"]}');
    expect(r.ok && r.value.allocators).toEqual(['a']);
  });
  test('JSON embedded in prose', () => {
    const r = parseAllocatorProfile('Sure!\n{"allocators":["a"],"deallocators":[]}\nDone.');
    expect(r.ok && r.value.allocators).toEqual(['a']);
  });
  test('garbage → not ok', () => {
    expect(parseAllocatorProfile('no json here').ok).toBe(false);
  });
});

describe('profileAllocators — end to end with a mock model', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cjson-'));
    writeFileSync(
      join(repo, 'cJSON.h'),
      `cJSON *cJSON_CreateObject(void);
       cJSON *cJSON_Duplicate(const cJSON *item, cJSON_bool recurse);
       void cJSON_Delete(cJSON *item);`,
    );
    mkdirSync(join(repo, 'tests'));
    writeFileSync(join(repo, 'tests', 'unity.h'), 'void TEST_ONLY(void);'); // excluded by walkCFiles
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test('gatherProjectApiText reads the public header', () => {
    const t = gatherProjectApiText(repo);
    expect(t).toContain('cJSON_CreateObject');
    expect(t).toContain('cJSON.h');
  });

  test('discovers verified allocators; drops a hallucinated name + libc free', async () => {
    const model = mockModel(
      JSON.stringify({
        allocators: ['cJSON_CreateObject', 'cJSON_Duplicate', 'cJSON_Imaginary'],
        deallocators: ['cJSON_Delete', 'free'],
        ownershipNotes: ['cJSON_Delete frees recursively'],
        confidence: 0.9,
      }),
    );
    const p = await profileAllocators(repo, model);
    expect(p?.allocators).toEqual(['cJSON_CreateObject', 'cJSON_Duplicate']); // Imaginary dropped (not in source)
    expect(p?.deallocators).toEqual(['cJSON_Delete']); // free dropped (libc)
    expect(p?.ownershipNotes?.[0]).toContain('recursively');
  });

  test('a model call failure returns null (caller keeps old behavior)', async () => {
    const failing = (async () => {
      throw new Error('boom');
    }) as unknown as CallModel;
    expect(await profileAllocators(repo, failing)).toBeNull();
  });
});
