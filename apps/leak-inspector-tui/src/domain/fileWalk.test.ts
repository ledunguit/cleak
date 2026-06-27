import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkCFiles } from './fileWalk';

describe('walkCFiles — excludes non-library dirs (F2 scan hygiene)', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fw-'));
    writeFileSync(join(root, 'cJSON.c'), 'int x;'); // library source — kept
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'core.c'), 'int z;'); // kept
    // Noise dirs whose .c files must be skipped.
    for (const d of ['tests', 'fuzzing', 'examples', 'benchmark', 'build', 'node_modules']) {
      mkdirSync(join(root, d));
      writeFileSync(join(root, d, 'noise.c'), 'int y;');
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('keeps library source, skips test/fuzz/example/benchmark/build/node_modules', () => {
    const rel = walkCFiles(root)
      .map((f) => f.slice(root.length + 1))
      .sort();
    expect(rel).toEqual(['cJSON.c', 'src/core.c']);
  });
});
