import { describe, expect, test } from 'bun:test';
import { LeakBundleSchema, DynamicCoverageSchema } from '../../src/validation/leak-bundle.schema';

const baseBundle = {
  bundleId: 'b1',
  candidate: {
    id: 'c1',
    function_name: 'f',
    file_path: 'x.c',
    line_number: 10,
    allocation_site: 'x.c:10',
    allocation_type: 'malloc',
    confidence: 'medium',
    context: '',
  },
  evidence: [],
  status: 'pending',
  createdAt: '',
  updatedAt: '',
};

describe('LeakBundleSchema — dynamicCoverage (back-compatible)', () => {
  test('a bundle WITHOUT dynamicCoverage still validates (back-compat)', () => {
    expect(LeakBundleSchema.safeParse(baseBundle).success).toBe(true);
  });

  test('every dynamicCoverage value round-trips', () => {
    for (const cov of ['exercised_clean', 'exercised_leak', 'not_exercised', 'dynamic_off'] as const) {
      const r = LeakBundleSchema.safeParse({ ...baseBundle, dynamicCoverage: cov });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.dynamicCoverage).toBe(cov);
    }
  });

  test('an unknown coverage value is rejected', () => {
    expect(LeakBundleSchema.safeParse({ ...baseBundle, dynamicCoverage: 'maybe_clean' }).success).toBe(false);
    expect(DynamicCoverageSchema.safeParse('maybe_clean').success).toBe(false);
  });

  test("a consensus-tool verdict validates (ToolKind.CONSENSUS)", () => {
    const withConsensus = {
      ...baseBundle,
      verdict: { verdict: 'confirmed_leak', confidence: 0.9, explanation: '', evidence: [], tool: 'consensus' },
    };
    expect(LeakBundleSchema.safeParse(withConsensus).success).toBe(true);
  });
});
