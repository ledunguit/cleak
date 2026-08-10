import { describe, expect, test } from 'vitest';
import { CandidateManager, computeBundleId, normalizeCandidate } from '../../src/domain/candidateState';
import type { LeakCandidate } from '@cleak/common/types';

function candidate(overrides: Partial<LeakCandidate> = {}): LeakCandidate {
  return {
    id: 'static-candidate-0001',
    function_name: 'glob_set',
    file_path: '/repo/lib/tool_urlglob.c',
    line_number: 138,
    allocation_site: '/repo/lib/tool_urlglob.c:138:curlx_malloc',
    allocation_type: 'curlx_malloc',
    confidence: 'medium',
    context: 'buf = curlx_malloc(len);',
    ...overrides,
  };
}

describe('computeBundleId', () => {
  test('gives distinct candidates in different files distinct ids, even with a shared path prefix and allocator suffix', () => {
    // Regression test for a real bug: the previous implementation built the id from
    // `Buffer.from(key).toString('hex').slice(-20) + .slice(0, 12)` — for any key
    // longer than 16 chars it kept only the first 6 and last 10 characters of the
    // original string. Every candidate in a repo shares a common path prefix and,
    // within an allocator type, a common suffix (the allocator name) — so distinct
    // candidates collapsed onto the identical bundleId. Confirmed on curl_1098e104:
    // 622 raw candidates collapsed to 65 surviving bundles.
    const a = candidate({ file_path: '/repo/lib/tool_urlglob.c', line_number: 138, allocation_site: '/repo/lib/tool_urlglob.c:138:curlx_malloc' });
    const b = candidate({ file_path: '/repo/lib/http.c', line_number: 912, allocation_site: '/repo/lib/http.c:912:curlx_malloc' });
    const c = candidate({ file_path: '/repo/lib/vtls/openssl.c', line_number: 412, allocation_site: '/repo/lib/vtls/openssl.c:412:curlx_malloc' });

    const ids = new Set([computeBundleId(a), computeBundleId(b), computeBundleId(c)]);
    expect(ids.size).toBe(3);
  });

  test('is stable/deterministic for the same allocation_site', () => {
    const a = candidate();
    const b = candidate();
    expect(computeBundleId(a)).toBe(computeBundleId(b));
  });

  test('falls back to file_path:line_number when allocation_site is empty, still distinguishing distinct sites', () => {
    const a = candidate({ allocation_site: '', file_path: '/repo/lib/very/deeply/nested/common/prefix/a.c', line_number: 10 });
    const b = candidate({ allocation_site: '', file_path: '/repo/lib/very/deeply/nested/common/prefix/b.c', line_number: 20 });
    expect(computeBundleId(a)).not.toBe(computeBundleId(b));
  });
});

describe('CandidateManager', () => {
  test('ingesting many distinct real-world-shaped candidates preserves all of them (no cross-file collapse)', () => {
    const mgr = new CandidateManager(() => '2026-01-01T00:00:00.000Z');
    const files = ['tool_urlglob.c', 'http.c', 'openssl.c', 'multi.c', 'easy.c'];
    const allocators = ['curlx_malloc', 'curlx_calloc', 'curlx_strdup', 'malloc', 'calloc'];
    let expected = 0;
    for (const file of files) {
      for (let line = 100; line < 130; line++) {
        const alloc = allocators[line % allocators.length];
        mgr.ingest(
          candidate({
            file_path: `/repo/lib/${file}`,
            line_number: line,
            allocation_site: `/repo/lib/${file}:${line}:${alloc}`,
            allocation_type: alloc,
          }),
        );
        expected++;
      }
    }
    expect(mgr.getAllBundles().length).toBe(expected);
  });

  test('ingesting the same candidate twice dedupes into a single bundle', () => {
    const mgr = new CandidateManager(() => '2026-01-01T00:00:00.000Z');
    mgr.ingest(candidate());
    mgr.ingest(candidate());
    expect(mgr.getAllBundles().length).toBe(1);
  });
});

describe('normalizeCandidate', () => {
  test('maps camelCase analyzer fields to the snake_case LeakCandidate shape', () => {
    const raw = {
      id: 'static-candidate-0001',
      functionName: 'glob_set',
      filePath: '/repo/lib/tool_urlglob.c',
      lineNumber: 138,
      allocationSite: '/repo/lib/tool_urlglob.c:138:curlx_malloc',
      allocationType: 'curlx_malloc',
      confidence: 'medium',
      context: 'buf = curlx_malloc(len);',
    };
    const normalized = normalizeCandidate(raw, (p) => p);
    expect(normalized).toEqual(
      candidate({
        function_name: 'glob_set',
        file_path: '/repo/lib/tool_urlglob.c',
        line_number: 138,
        allocation_site: '/repo/lib/tool_urlglob.c:138:curlx_malloc',
        allocation_type: 'curlx_malloc',
      }),
    );
  });
});
