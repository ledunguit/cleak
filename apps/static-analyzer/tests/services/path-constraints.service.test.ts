import { describe, expect, test } from 'vitest';
import { PathConstraintsService } from '../../src/services/path-constraints.service';
import { CParserService } from '../../src/services/c-parser.service';

const svc = new PathConstraintsService(new CParserService());

const SRC = `
#include <stdlib.h>
void target(int n) {
    char *buf = malloc(64);
    if (buf == NULL) { return; }
    if (n > 0) { free(buf); }
    return;
}
void other(void) { ; }
`;

describe('PathConstraintsService — enclosing-function selection and path constraints', () => {
  test('a line inside the only real function picks that function and reports its constraints', async () => {
    const r = await svc.analyze('pc.c', SRC, 4);

    // 4 = malloc line inside target(); constraints are the function's conditions
    expect(r.constraints).toHaveLength(2);
    expect(r.constraints[0]).toContain('at line 5');
    expect(r.constraints[1]).toContain('at line 6');
    expect(r.totalExitPaths).toBeGreaterThan(0);
    expect(r.containsEarlyReturn).toBe(true);
  });

  test('pathsToTarget: conditions before the target line are labeled in source order (index-based single pass)', async () => {
    const r = await svc.analyze('pc.c', SRC, 7); // line after both conditions

    // `path through line N: ...` labels come from conditions.indexOf(cond) + 1 — the
    // refactor replaced the O(C²) indexOf scan with an index-based loop; labels must
    // be unchanged (1-based condition order).
    expect(r.pathsToTarget[0]).toBe('path through line 1: if (buf == NULL) { return; }');
    expect(r.pathsToTarget[1]).toBe('path through line 2: if (n > 0) { free(buf); }');
  });

  test('a line in a condition-less function still resolves to that function (direct path fallback)', async () => {
    const r = await svc.analyze('pc.c', SRC, 9); // body of `other`

    expect(r.constraints).toEqual([]);
    expect(r.pathsToTarget).toEqual(['direct path (no conditions before target)']);
  });

  test('a line in no function returns the empty result (no crash, no fallback function)', async () => {
    const r = await svc.analyze('pc.c', SRC, 1); // include/comment area

    expect(r).toEqual({ constraints: [], feasiblePaths: [], exitPaths: [] });
  });
});
