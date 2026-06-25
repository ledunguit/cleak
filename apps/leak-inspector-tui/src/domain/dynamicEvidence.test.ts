import { describe, expect, test } from 'bun:test';
import {
  createDynamicRunStore,
  withDynamicEvidenceCapture,
  reconcileDynamicEvidence,
  computeDynamicCoverage,
  runDeterministicDynamic,
  type DynamicRunStore,
} from './dynamicEvidence';
import { PathResolver } from './pathResolver';
import type { LeakBundle } from '@cleak/common/types';

const idResolver = new PathResolver(); // identity (no host↔analyzer mapping)

function bundle(over: { file?: string; line?: number; fn?: string; id?: string } = {}): LeakBundle {
  return {
    bundleId: over.id ?? 'b1',
    candidate: {
      id: 'c',
      function_name: over.fn ?? 'bad',
      file_path: over.file ?? 'a.c',
      line_number: over.line ?? 10,
      allocation_site: '',
      allocation_type: 'malloc',
      confidence: 'medium',
      context: '',
    },
    evidence: [],
    status: 'pending' as any,
    createdAt: '',
    updatedAt: '',
  };
}

/** A valgrind-shaped leak finding at file:line in function. */
const leakFinding = (file: string, line: number, fn: string) => ({
  functionName: fn,
  filePath: file,
  lineNumber: line,
  bytesLost: 100,
  blocksLost: 1,
  severity: 'high',
  allocationType: 'definitely_lost',
  stackTrace: `${fn} at ${file}:${line}`,
});

const fakeTool = (name: string, result: any) => ({ name, description: '', call: async () => result }) as any;

describe('withDynamicEvidenceCapture', () => {
  test('non-run tools pass through untouched', () => {
    const store = createDynamicRunStore();
    const t = fakeTool('buildTarget', { success: true });
    expect(withDynamicEvidenceCapture(t, store)).toBe(t);
  });

  test('a run tool records its findings into the store (no LLM discretion)', async () => {
    const store = createDynamicRunStore();
    const wrapped = withDynamicEvidenceCapture(fakeTool('lsanRun', { success: true, runId: 'r1', findings: [leakFinding('a.c', 10, 'bad')] }), store);
    await wrapped.call({}, {});
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ tool: 'lsan', runId: 'r1', success: true });
    expect(store.runs[0].findings).toHaveLength(1);
  });
});

describe('reconcileDynamicEvidence', () => {
  test('attaches a correlated leak to the matching bundle, deterministically', () => {
    const store: DynamicRunStore = { runs: [{ tool: 'lsan', runId: 'r1', success: true, findings: [leakFinding('a.c', 10, 'bad')] }] };
    const bundles = [bundle({ id: 'A', file: 'a.c', line: 10, fn: 'bad' }), bundle({ id: 'B', file: 'b.c', line: 5, fn: 'other' })];
    reconcileDynamicEvidence(store, bundles, idResolver);
    expect(bundles[0].evidence).toHaveLength(1);
    expect(bundles[0].evidence[0].correlatedToCandidate).toBe(true);
    expect(bundles[1].evidence).toHaveLength(0);
  });

  test('is idempotent — reconciling twice does NOT duplicate evidence', () => {
    const store: DynamicRunStore = { runs: [{ tool: 'lsan', runId: 'r1', success: true, findings: [leakFinding('a.c', 10, 'bad')] }] };
    const bundles = [bundle({ id: 'A', file: 'a.c', line: 10, fn: 'bad' })];
    reconcileDynamicEvidence(store, bundles, idResolver);
    reconcileDynamicEvidence(store, bundles, idResolver);
    expect(bundles[0].evidence).toHaveLength(1); // signature dedup
  });

  test('skips failed runs', () => {
    const store: DynamicRunStore = { runs: [{ tool: 'lsan', runId: 'r1', success: false, findings: [leakFinding('a.c', 10, 'bad')] }] };
    const bundles = [bundle({ id: 'A', file: 'a.c', line: 10, fn: 'bad' })];
    reconcileDynamicEvidence(store, bundles, idResolver);
    expect(bundles[0].evidence).toHaveLength(0);
  });
});

describe('findingToEvidence — MCP finding-shape tolerance (via reconcile)', () => {
  // MCP analyzers return findings in several shapes (camelCase, snake_case, nested
  // `location`, byte counts under `aux.leak`). Lock the field extraction so a shape
  // drift surfaces as a failing test instead of silently zeroing a field.
  const reconcileOne = (finding: any) => {
    const b = bundle({ file: 'a.c', line: 10, fn: 'bad' });
    reconcileDynamicEvidence({ runs: [{ tool: 'lsan', runId: 'r', success: true, findings: [finding] }] }, [b], idResolver);
    return b.evidence[0];
  };

  test('snake_case fields are read + correlated', () => {
    const e = reconcileOne({ function_name: 'bad', file_path: 'a.c', line_number: 10, bytes_lost: 50, blocks_lost: 2, allocation_type: 'definitely_lost' });
    expect(e).toBeDefined();
    expect(e.file_path).toBe('a.c');
    expect(e.line_number).toBe(10);
    expect(e.bytes_lost).toBe(50);
    expect(e.correlatedToCandidate).toBe(true);
  });

  test('nested location.{file,line,function} is read', () => {
    const e = reconcileOne({ location: { file: 'a.c', line: 10, function: 'bad' }, kind: 'definitely_lost', bytesLost: 8 });
    expect(e).toBeDefined();
    expect(e.line_number).toBe(10);
    expect(e.bytes_lost).toBe(8);
    expect(e.correlatedToCandidate).toBe(true);
  });

  test('byte counts recovered from aux.leak when no top-level field', () => {
    const e = reconcileOne({ filePath: 'a.c', lineNumber: 10, functionName: 'bad', kind: 'definitely_lost', aux: { leak: { bytes: 256, blocks: 3 } } });
    expect(e.bytes_lost).toBe(256);
    expect(e.blocks_lost).toBe(3);
  });

  test('a stack[] array is rendered into the stack_trace string', () => {
    const e = reconcileOne({ functionName: 'bad', filePath: 'a.c', lineNumber: 10, kind: 'definitely_lost', stack: [{ function: 'malloc', file: 'libc', line: 0 }, { function: 'bad', file: 'a.c', line: 10 }] });
    expect(e.stack_trace).toContain('bad at a.c:10');
  });
});

describe('computeDynamicCoverage', () => {
  test('dynamic disabled → dynamic_off', () => {
    expect(computeDynamicCoverage(createDynamicRunStore(), bundle(), false)).toBe('dynamic_off');
  });

  test('no successful run → not_exercised', () => {
    const store: DynamicRunStore = { runs: [{ tool: 'lsan', runId: 'r1', success: false, findings: [] }] };
    expect(computeDynamicCoverage(store, bundle(), true)).toBe('not_exercised');
  });

  test('successful run + correlated leak on the bundle → exercised_leak', () => {
    const store: DynamicRunStore = { runs: [{ tool: 'lsan', runId: 'r1', success: true, findings: [leakFinding('a.c', 10, 'bad')] }] };
    const b = bundle({ file: 'a.c', line: 10, fn: 'bad' });
    reconcileDynamicEvidence(store, [b], idResolver);
    expect(computeDynamicCoverage(store, b, true)).toBe('exercised_leak');
  });

  test('successful run + no leak on the bundle → exercised_clean (honest exoneration)', () => {
    const store: DynamicRunStore = { runs: [{ tool: 'lsan', runId: 'r1', success: true, findings: [leakFinding('a.c', 10, 'bad')] }] };
    const good = bundle({ id: 'G', file: 'good.c', line: 99, fn: 'goodB2G' });
    reconcileDynamicEvidence(store, [good], idResolver);
    expect(good.evidence).toHaveLength(0);
    expect(computeDynamicCoverage(store, good, true)).toBe('exercised_clean');
  });
});

describe('runDeterministicDynamic (fixed recipe, no LLM)', () => {
  test('calls buildTarget then lsanRun, captures findings, returns true', async () => {
    const calls: string[] = [];
    const tools = [
      { name: 'buildTarget', description: '', call: async (i: any) => { calls.push('build:' + i.buildCommand); return { success: true, binaryPath: '/w/a.out' }; } },
      { name: 'lsanRun', description: '', call: async (i: any) => { calls.push('lsan:' + i.binaryPath); return { success: true, runId: 'r', findings: [leakFinding('a.c', 10, 'bad')] }; } },
    ] as any[];
    const store = createDynamicRunStore();
    const ok = await runDeterministicDynamic({ tools, store, repoPath: '/w', buildCommand: 'make', pathResolver: idResolver, toolCtx: {} });
    expect(ok).toBe(true);
    expect(calls).toEqual(['build:make', 'lsan:/w/a.out']); // build first, then lsan on the built binary
    expect(store.runs).toHaveLength(1); // the lsan findings were captured deterministically
    expect(store.runs[0].findings).toHaveLength(1);
  });

  test('a failed build returns false (caller falls back to the LLM worker)', async () => {
    const tools = [
      { name: 'buildTarget', description: '', call: async () => ({ success: false, errors: ['boom'] }) },
      { name: 'lsanRun', description: '', call: async () => ({ success: true, findings: [] }) },
    ] as any[];
    const store = createDynamicRunStore();
    expect(await runDeterministicDynamic({ tools, store, repoPath: '/w', buildCommand: 'make', pathResolver: idResolver, toolCtx: {} })).toBe(false);
    expect(store.runs).toHaveLength(0); // lsan never ran
  });

  test('missing buildTarget/lsanRun tool → false', async () => {
    const store = createDynamicRunStore();
    expect(await runDeterministicDynamic({ tools: [], store, repoPath: '/w', buildCommand: 'make', pathResolver: idResolver, toolCtx: {} })).toBe(false);
  });
});
