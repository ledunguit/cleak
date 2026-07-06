import { describe, expect, test } from 'bun:test';
import { snapshotFindingToView, bundleToFindingView, verdictSeverityRank } from '../../../../src/surfaces/tui/findings/findingView';

const richSnapshotFinding = {
  id: 'b1', function: 'bad', file: 'a.c', line: 10, allocation_type: 'malloc',
  verdict: 'confirmed_leak', verdict_tool: 'consensus', dynamic_coverage: 'exercised_leak', confidence: 0.9,
  explanation: 'leaks', repair_suggestion: 'free(p)',
  root_cause: { patternType: 'early_return' },
  repair_diff: { startLine: 12, originalLines: ['return;'], suggestedLines: ['free(p); return;'] },
  evidence: [{ tool: 'lsan', bytes_lost: 100, correlated_to_candidate: true, correlation_method: 'file_line_exact', leak_kind: 'definitely_lost', alloc_site: { file: 'a.c', line: 10, function: 'bad' } }],
  consensus: { agreement: 0.667, samples: [{ verdict: 'confirmed_leak', confidence: 0.9 }], overridden: false, evidence_fusion: { static: 'leak', dynamic: 'confirmed' } },
  static_evidence: { ownership: { role: 'allocator', rationale: 'no free' }, alloc_free_pairs: [{ variable: 'p', alloc_line: 10, free_line: null, status: 'unpaired' }], feasible_leak_paths: [{ narrative: 'alloc → return without free', leak_risk: 'high', reachable: true }] },
};

describe('snapshotFindingToView', () => {
  test('maps a rich (Phase-0) finding fully', () => {
    const v = snapshotFindingToView(richSnapshotFinding);
    expect(v).toMatchObject({ verdict: 'confirmed_leak', verdictTool: 'consensus', dynamicCoverage: 'exercised_leak' });
    expect(v.consensus?.agreement).toBeCloseTo(0.667, 3);
    expect(v.evidence[0]).toMatchObject({ correlatedToCandidate: true, correlationMethod: 'file_line_exact', leakKind: 'definitely_lost' });
    expect(v.staticEvidence?.feasiblePaths[0].narrative).toContain('without free');
    expect(v.repairDiff?.suggestedLines).toEqual(['free(p); return;']);
  });

  test('an OLD (pre-Phase-0) finding degrades gracefully — no consensus/static, no throw', () => {
    const v = snapshotFindingToView({ id: 'x', function: 'f', file: 'a.c', line: 1, verdict: 'false_positive', confidence: 0.8 });
    expect(v.consensus).toBeUndefined();
    expect(v.staticEvidence).toBeUndefined();
    expect(v.evidence).toEqual([]);
    expect(v.dynamicCoverage).toBe('dynamic_off');
  });
});

describe('bundleToFindingView', () => {
  test('an in-memory consensus bundle yields the same FindingView shape', () => {
    const bundle = {
      bundleId: 'b1',
      candidate: { function_name: 'bad', file_path: 'a.c', line_number: 10, allocation_type: 'malloc' },
      verdict: { verdict: 'confirmed_leak', confidence: 0.9, tool: 'consensus', explanation: 'leaks', samples: [{ verdict: 'confirmed_leak', confidence: 0.9 }], agreement: 0.667, overridden: false, evidenceFusion: { static: 'leak', dynamic: 'confirmed' } },
      evidence: [{ tool: 'lsan', bytes_lost: 100, correlatedToCandidate: true, correlationMethod: 'file_line_exact', leakKind: 'definitely_lost', allocSite: { file: 'a.c', line: 10, function: 'bad' } }],
      staticEvidence: { ownership: { role: 'allocator', ownershipCarrier: { kind: 'none' }, rationale: 'no free' }, allocFreePairs: [{ variable: 'p', allocLine: 10, freeLine: null, status: 'unpaired' }], feasibleLeakPaths: [{ narrative: 'alloc → return without free', leakRisk: 'high', reachable: true }] },
      dynamicCoverage: 'exercised_leak',
    } as any;
    const v = bundleToFindingView(bundle);
    expect(v.verdict).toBe('confirmed_leak');
    expect(v.consensus?.samples).toHaveLength(1);
    expect(v.evidence[0].correlatedToCandidate).toBe(true);
    expect(v.staticEvidence?.ownership?.role).toBe('allocator');
  });
});

describe('verdictSeverityRank', () => {
  test('orders confirmed > likely > uncertain > likely_fp > fp', () => {
    const order = ['confirmed_leak', 'likely_leak', 'uncertain', 'likely_false_positive', 'false_positive'];
    const ranks = order.map(verdictSeverityRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a)); // already descending
  });
});
