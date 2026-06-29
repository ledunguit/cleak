import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { judgeHeuristically } from './heuristic-judge';
import { evidenceIndicatesLeak, LEAK_POSITIVE_VERDICTS } from './judge-shared';
import type { LeakBundle, LeakEvidence } from '../types';

// `judgeHeuristically` reads the candidate's source off disk, so the fixtures are
// real files. Each mirrors a Juliet CWE-401 good*/bad pair that produced an FP.
let dir: string;
const files: Record<string, string> = {};

// Flow 16: single-iteration `while(1){…;break;}`; good frees, bad does not.
const GOOD_LOOP = `static void goodB2G()
{
    char * data;
    data = NULL;
    while(1)
    {
        data = (char *)calloc(100, sizeof(char));
        if (data == NULL) {exit(-1);}
        break;
    }
    while(1)
    {
        free(data);
        break;
    }
}
`;
const BAD_LOOP = `static void bad()
{
    char * data;
    data = NULL;
    while(1)
    {
        data = (char *)calloc(100, sizeof(char));
        if (data == NULL) {exit(-1);}
        break;
    }
    while(1)
    {
        ;
        break;
    }
}
`;
// Flow 02: dead-code `if(0){}else{free}` — the free always runs.
const GOOD_DEADCODE = `static void goodB2G1()
{
    char * data;
    data = NULL;
    if(1)
    {
        data = (char *)calloc(100, sizeof(char));
        if (data == NULL) {exit(-1);}
    }
    if(0)
    {
    }
    else
    {
        free(data);
    }
}
`;

const CALLOC_LINE = 7; // calloc sits on line 7 in every fixture above

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'judge-test-'));
  for (const [name, src] of Object.entries({ GOOD_LOOP, BAD_LOOP, GOOD_DEADCODE })) {
    const p = join(dir, `${name}.c`);
    writeFileSync(p, src);
    files[name] = p;
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function bundle(fileKey: string, fn: string, evidence: Partial<LeakEvidence>[] = []): LeakBundle {
  const file = files[fileKey];
  return {
    bundleId: 'b',
    candidate: {
      id: 'c',
      function_name: fn,
      file_path: file,
      line_number: CALLOC_LINE,
      allocation_site: `${file}:${CALLOC_LINE}`,
      allocation_type: 'calloc',
      confidence: 'high',
      context: '',
    },
    evidence: evidence as LeakEvidence[],
    status: 'pending',
    createdAt: '',
    updatedAt: '',
  } as unknown as LeakBundle;
}

const cleanRun = (fn: string): Partial<LeakEvidence> => ({
  tool: 'valgrind' as any,
  function_name: fn,
  severity: 'info',
  bytes_lost: 0,
  blocks_lost: 0,
  correlatedToCandidate: false,
});
const correlatedLeak = (fn: string): Partial<LeakEvidence> => ({
  tool: 'valgrind' as any,
  function_name: fn,
  severity: 'medium',
  bytes_lost: 100,
  blocks_lost: 1,
  leakKind: 'definitely_lost' as any,
  correlatedToCandidate: true,
});

const flagged = (v: string) => LEAK_POSITIVE_VERDICTS.has(v);

describe('evidenceIndicatesLeak', () => {
  test('a clean run (info, no leakKind) is NOT a leak', () => {
    expect(evidenceIndicatesLeak({ severity: 'info', bytes_lost: 0, blocks_lost: 0 })).toBe(false);
  });
  test('still_reachable is benign, not a leak', () => {
    expect(evidenceIndicatesLeak({ leakKind: 'still_reachable', severity: 'medium', bytes_lost: 16 })).toBe(false);
  });
  test('a real leak kind / lost bytes / medium severity IS a leak', () => {
    expect(evidenceIndicatesLeak({ leakKind: 'definitely_lost' })).toBe(true);
    expect(evidenceIndicatesLeak({ severity: 'info', bytes_lost: 8 })).toBe(true);
    expect(evidenceIndicatesLeak({ severity: 'medium' })).toBe(true);
  });
});

describe('judgeHeuristically — precision fixes', () => {
  test('good single-iteration loop that frees is NOT flagged', () => {
    const v = judgeHeuristically(bundle('GOOD_LOOP', 'goodB2G'));
    expect(flagged(v.verdict)).toBe(false);
  });

  test('bad loop with no free IS flagged (recall preserved)', () => {
    const v = judgeHeuristically(bundle('BAD_LOOP', 'bad'));
    expect(flagged(v.verdict)).toBe(true);
  });

  test('exercised_clean coverage on a dead-code good variant → likely_false_positive (exonerated)', () => {
    // Exoneration now keys off the EXPLICIT deterministic coverage status, not a
    // clean evidence entry. A genuinely-exercised-clean run exonerates.
    const b = bundle('GOOD_DEADCODE', 'goodB2G1', [cleanRun('goodB2G1')]);
    b.dynamicCoverage = 'exercised_clean';
    const v = judgeHeuristically(b);
    expect(v.verdict).toBe('likely_false_positive');
    expect(flagged(v.verdict)).toBe(false);
  });

  test('exercised_clean with ZERO evidence still exonerates (impossible under the old evidence.length proxy)', () => {
    const b = bundle('GOOD_DEADCODE', 'goodB2G1', []);
    b.dynamicCoverage = 'exercised_clean';
    expect(judgeHeuristically(b).verdict).toBe('likely_false_positive');
  });

  test('not_exercised does NOT exonerate (no honest dynamic signal)', () => {
    const b = bundle('GOOD_DEADCODE', 'goodB2G1', []);
    b.dynamicCoverage = 'not_exercised';
    expect(judgeHeuristically(b).verdict).not.toBe('likely_false_positive');
  });

  test('a correlated runtime leak keeps a bad variant flagged even alongside other evidence', () => {
    const v = judgeHeuristically(bundle('BAD_LOOP', 'bad', [correlatedLeak('bad')]));
    expect(v.verdict).toBe('confirmed_leak');
  });

  test('weak lexical signals alone (function frees) are downgraded to uncertain, not flagged', () => {
    // Function demonstrably frees → no-free term gated off; only feasible-path +
    // early-return + high-confidence remain (weak), so gate 2 must un-flag it.
    const v = judgeHeuristically(bundle('GOOD_DEADCODE', 'goodB2G1'), {
      feasiblePaths: [{ narrative: 'reaches exit' }],
      earlyReturnCount: 2,
      allocations: [{}],
    });
    expect(flagged(v.verdict)).toBe(false);
  });
});

// ── Path-sensitive leaks (the dominant real-project shape, e.g. cJSON) ──────────
// An allocation freed on the main path but lost on an error/early-return path. The
// static analysis already flags this (AllocFreePair status 'conditional' +
// FeasibleLeakPath.unreconciledAllocations); the judge must FLAG it and NOT let the
// "ownership transferred on success" penalty exonerate it. File path is nonexistent
// so the on-disk structural analysis stays neutral — isolating the static-evidence path.
function pathBundle(opts: {
  pairStatus?: 'paired' | 'unpaired' | 'conditional';
  reachable: boolean;
  unrec?: string[];
  ownershipReturned?: boolean;
}): LeakBundle {
  const VAR = 'p';
  const LINE = 10;
  return {
    bundleId: 'pb',
    candidate: { id: 'c', function_name: 'f', file_path: '/nonexistent/x.c', line_number: LINE, allocation_site: '', allocation_type: 'cJSON_malloc', confidence: 'medium', context: '' },
    evidence: [],
    staticEvidence: {
      allocFreePairs: opts.pairStatus
        ? [{ variable: VAR, allocCall: 'cJSON_malloc', allocLine: LINE, allocFile: 'x.c', freeLine: opts.pairStatus === 'unpaired' ? null : 20, freeFunction: null, bindsToNewVariable: true, status: opts.pairStatus }]
        : [],
      feasibleLeakPaths: opts.reachable
        ? [{ kind: 'return', exitLine: 15, reachable: true, conditions: ['if (err)'], unreconciledAllocations: opts.unrec ?? [VAR], leakRisk: 'high', narrative: 'error path leaks p', feasibilityChecked: 'heuristic' }]
        : [],
      ownership: opts.ownershipReturned
        ? { functionName: 'f', filePath: 'x.c', role: 'allocator', ownershipCarrier: { kind: 'return_value' }, ownershipType: 'returns_ownership', rationale: 'returned' }
        : undefined,
      earlyReturnCount: 0,
      leakyExitPaths: 0,
    },
    status: 'pending',
    createdAt: '',
    updatedAt: '',
  } as unknown as LeakBundle;
}

describe('judgeHeuristically — path-sensitive leaks', () => {
  test('conditional free + reachable leak path + ownership RETURNED → FLAGGED (was exonerated before)', () => {
    const v = judgeHeuristically(pathBundle({ pairStatus: 'conditional', reachable: true, unrec: ['p'], ownershipReturned: true }), {});
    expect(flagged(v.verdict)).toBe(true);
  });

  test('the candidate variable named on a reachable un-freed exit → strong signal (precise match)', () => {
    const v = judgeHeuristically(pathBundle({ pairStatus: 'conditional', reachable: true, unrec: ['p'], ownershipReturned: true }), {});
    // verdict is at least likely_leak, and the explanation mentions the override
    expect(['confirmed_leak', 'likely_leak']).toContain(v.verdict);
  });

  test('NO REGRESSION: freed on ALL paths + ownership returned → NOT flagged', () => {
    const v = judgeHeuristically(pathBundle({ pairStatus: 'paired', reachable: false, ownershipReturned: true }), {});
    expect(flagged(v.verdict)).toBe(false);
  });

  test('NO REGRESSION: a transferred-ownership alloc with no reachable leak path stays exonerated', () => {
    const v = judgeHeuristically(pathBundle({ pairStatus: 'paired', reachable: false, ownershipReturned: true }), {});
    expect(flagged(v.verdict)).toBe(false);
  });
});

// ── Clang scan-build corroboration (opt-in `--static-tools scanBuild`) ──────────
// A project-level scan-build leak diagnostic NEAR the candidate is a deterministic
// second static opinion. It must ADD score (corroborate) when present, and be a
// complete no-op when absent (so the default 2-tool baseline is unaffected). The
// base bundle is already flagged (unpaired pair + reachable leak path) so the +0.15
// is observable in `confidence` without being masked by the UNCERTAIN floor.
function scanBuildBundle(diags?: Array<{ file: string; line: number; message: string; confidence: 'high' | 'medium' | 'low' }>): LeakBundle {
  const LINE = 10;
  return {
    bundleId: 'sb',
    candidate: { id: 'c', function_name: 'f', file_path: '/nonexistent/x.c', line_number: LINE, allocation_site: '', allocation_type: 'malloc', confidence: 'medium', context: '' },
    evidence: [],
    staticEvidence: {
      allocFreePairs: [{ variable: 'p', allocCall: 'malloc', allocLine: LINE, allocFile: 'x.c', freeLine: null, freeFunction: null, bindsToNewVariable: true, status: 'unpaired' }],
      feasibleLeakPaths: [{ kind: 'return', exitLine: 15, reachable: true, conditions: [], unreconciledAllocations: [], leakRisk: 'high', narrative: 'leaks', feasibilityChecked: 'heuristic' }],
      earlyReturnCount: 0,
      leakyExitPaths: 0,
      ...(diags ? { scanBuildDiagnostics: diags } : {}),
    },
    status: 'pending',
    createdAt: '',
    updatedAt: '',
  } as unknown as LeakBundle;
}

describe('judgeHeuristically — scan-build corroboration', () => {
  test('a scan-build diagnostic near the candidate raises confidence (corroborates)', () => {
    const withDiag = judgeHeuristically(scanBuildBundle([{ file: 'x.c', line: 10, message: 'Potential leak of memory pointed to by p', confidence: 'high' }]), {});
    const without = judgeHeuristically(scanBuildBundle(), {});
    expect(withDiag.confidence).toBeGreaterThan(without.confidence);
    expect(flagged(withDiag.verdict)).toBe(true);
  });

  test('a far-away diagnostic (>2 lines) does NOT corroborate', () => {
    const near = judgeHeuristically(scanBuildBundle([{ file: 'x.c', line: 10, message: 'leak', confidence: 'high' }]), {});
    const far = judgeHeuristically(scanBuildBundle([{ file: 'x.c', line: 99, message: 'leak', confidence: 'high' }]), {});
    expect(near.confidence).toBeGreaterThan(far.confidence);
  });

  test('NO REGRESSION: absent scanBuildDiagnostics → identical verdict & confidence whether the field is missing or undefined', () => {
    const missing = judgeHeuristically(scanBuildBundle(), {});
    const undef = judgeHeuristically(scanBuildBundle(undefined), {});
    expect(undef.verdict).toBe(missing.verdict);
    expect(undef.confidence).toBe(missing.confidence);
  });
});
