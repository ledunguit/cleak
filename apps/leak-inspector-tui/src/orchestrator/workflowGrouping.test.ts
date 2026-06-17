import { describe, expect, test } from 'bun:test';
import { groupByFileAffinity } from './workflowInvestigation';
import type { LeakBundle } from '@mcpvul/common/types';

const b = (id: string, file: string): LeakBundle =>
  ({ bundleId: id, candidate: { file_path: file, function_name: 'f', line_number: 1 } } as any);

describe('groupByFileAffinity', () => {
  test('never splits a file across groups; packs files up to the cap', () => {
    const bundles = [b('1', 'a.c'), b('2', 'a.c'), b('3', 'b.c'), b('4', 'c.c')];
    const groups = groupByFileAffinity(bundles, 2);
    // a.c (2) fills a group; b.c+c.c (1+1) pack into the next.
    for (const g of groups) {
      const files = new Set(g.map((x) => x.candidate.file_path));
      // every file in a group is wholly contained (no file appears in two groups)
      for (const f of files) {
        const total = bundles.filter((x) => x.candidate.file_path === f).length;
        const inGroup = g.filter((x) => x.candidate.file_path === f).length;
        expect(inGroup).toBe(total);
      }
    }
    expect(groups.flat()).toHaveLength(4);
  });

  test('is deterministic (sorted files) — identical output across calls', () => {
    const bundles = [b('3', 'c.c'), b('1', 'a.c'), b('2', 'b.c')];
    const a = groupByFileAffinity(bundles, 1).map((g) => g.map((x) => x.bundleId));
    const c = groupByFileAffinity(bundles, 1).map((g) => g.map((x) => x.bundleId));
    expect(a).toEqual(c);
    expect(a).toEqual([['1'], ['2'], ['3']]); // sorted by file a.c < b.c < c.c
  });

  test('a single oversize file stays whole rather than being split', () => {
    const bundles = [b('1', 'big.c'), b('2', 'big.c'), b('3', 'big.c')];
    const groups = groupByFileAffinity(bundles, 2);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });
});
