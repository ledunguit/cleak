import { describe, expect, test } from 'vitest';
import { loadBaselines } from '../baselines';

const BASELINES_DIR = 'configs/baselines';

describe('loadBaselines', () => {
  test('no filter returns every config, id-sorted', () => {
    const configs = loadBaselines(BASELINES_DIR);
    expect(configs.length).toBeGreaterThanOrEqual(9);
    const ids = configs.map((c) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    expect(ids).toContain('B1');
    expect(ids).toContain('B7');
  });

  test('filters to only the requested ids, in catalog order (not request order)', () => {
    const configs = loadBaselines(BASELINES_DIR, ['B7', 'B1']);
    expect(configs.map((c) => c.id)).toEqual(['B1', 'B7']);
  });

  test('an unknown id yields no match for that id, without throwing', () => {
    const configs = loadBaselines(BASELINES_DIR, ['B1', 'NOPE']);
    expect(configs.map((c) => c.id)).toEqual(['B1']);
  });

  test('an empty filter list behaves like no filter (not "match nothing")', () => {
    const all = loadBaselines(BASELINES_DIR);
    const filtered = loadBaselines(BASELINES_DIR, []);
    expect(filtered.map((c) => c.id)).toEqual(all.map((c) => c.id));
  });
});
