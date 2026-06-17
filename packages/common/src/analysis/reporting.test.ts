import { describe, expect, test } from 'bun:test';
import { LeakReporting } from './reporting';

const reporting = new LeakReporting();

const candidate = (fn: string) => ({
  id: 'c', function_name: fn, file_path: 'a.c', line_number: 10, allocation_site: 'a.c:10',
  allocation_type: 'malloc', confidence: 'medium', context: '',
});

/** A bundle judged by consensus, with static evidence + a correlated runtime leak. */
const consensusBundle = {
  bundleId: 'b1',
  candidate: candidate('bad'),
  verdict: {
    verdict: 'confirmed_leak', confidence: 0.9, explanation: 'leaks', evidence: [], tool: 'consensus',
    samples: [{ verdict: 'confirmed_leak', confidence: 0.9 }, { verdict: 'confirmed_leak', confidence: 0.85 }, { verdict: 'likely_leak', confidence: 0.6 }],
    agreement: 0.667, overridden: false, evidenceFusion: { static: 'leak', dynamic: 'confirmed' },
  },
  evidence: [{ tool: 'lsan', file_path: 'a.c', line_number: 10, function_name: 'bad', bytes_lost: 100, blocks_lost: 1, severity: 'high', correlatedToCandidate: true, correlationMethod: 'file_line_exact', leakKind: 'definitely_lost', allocSite: { file: 'a.c', line: 10, function: 'bad' } }],
  staticEvidence: {
    ownership: { functionName: 'bad', filePath: 'a.c', role: 'allocator', ownershipCarrier: { kind: 'none' }, ownershipType: 'local_ownership', rationale: 'allocates but never frees' },
    allocFreePairs: [{ variable: 'p', allocCall: 'malloc', allocLine: 10, allocFile: 'a.c', freeLine: null, freeFunction: null, bindsToNewVariable: true, status: 'unpaired' }],
    feasibleLeakPaths: [{ kind: 'return', exitLine: 14, reachable: true, conditions: [], unreconciledAllocations: ['p'], leakRisk: 'high', narrative: 'alloc p at 10 → return at 14 without free(p)', feasibilityChecked: 'heuristic' }],
    earlyReturnCount: 1, leakyExitPaths: 1,
  },
  dynamicCoverage: 'exercised_leak',
  status: 'confirmed', createdAt: '', updatedAt: '',
} as any;

/** A heuristic-only bundle — no consensus samples, no static evidence. */
const heuristicBundle = {
  bundleId: 'b2', candidate: candidate('goodB2G'),
  verdict: { verdict: 'false_positive', confidence: 0.8, explanation: 'freed', evidence: [], tool: 'heuristic' },
  evidence: [], dynamicCoverage: 'exercised_clean', status: 'dismissed', createdAt: '', updatedAt: '',
} as any;

const report = (bundles: any[]) =>
  ({ scanId: 's', metadata: { workspacePath: '/w' }, bundles, summary: { confirmedLeaks: 1, likelyLeaks: 0, falsePositives: 0, totalBytesLost: 100, toolsUsed: [], durationSec: 1 } }) as any;

describe('toSnapshot — novelty fields (additive, guarded)', () => {
  const snap = JSON.parse(reporting.toSnapshot(report([consensusBundle, heuristicBundle])));
  const f0 = snap.findings[0];
  const f1 = snap.findings[1];

  test('a consensus verdict serializes consensus voting (agreement + samples)', () => {
    expect(f0.consensus.agreement).toBeCloseTo(0.667, 3);
    expect(f0.consensus.samples).toHaveLength(3);
    expect(f0.consensus.evidence_fusion).toEqual({ static: 'leak', dynamic: 'confirmed' });
    expect(f0.consensus.overridden).toBe(false);
  });

  test('static evidence (ownership + pairs + feasible-path narrative) is serialized', () => {
    expect(f0.static_evidence.ownership.role).toBe('allocator');
    expect(f0.static_evidence.alloc_free_pairs[0].status).toBe('unpaired');
    expect(f0.static_evidence.feasible_leak_paths[0].narrative).toContain('without free');
    expect(f0.static_evidence.feasible_leak_paths[0].leak_risk).toBe('high');
  });

  test('evidence carries correlation (LINKED provenance)', () => {
    expect(f0.evidence[0].correlated_to_candidate).toBe(true);
    expect(f0.evidence[0].correlation_method).toBe('file_line_exact');
    expect(f0.evidence[0].leak_kind).toBe('definitely_lost');
  });

  test('a heuristic-only bundle omits consensus + static_evidence (no noise)', () => {
    expect(f1.consensus).toBeUndefined();
    expect(f1.static_evidence).toBeUndefined();
    expect(f1.dynamic_coverage).toBe('exercised_clean'); // still carries coverage
  });
});
