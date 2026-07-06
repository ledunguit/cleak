import { describe, expect, test } from 'bun:test';
import { synthesizeCandidatesFromStore } from '../../src/domain/dynamicDiscovery';
import type { DynamicRunStore } from '../../src/domain/dynamicEvidence';

// Minimal pathResolver — leakSiteFromFinding only calls toHostPath.
const pr = { toHostPath: (p: string) => p } as any;

const lsanRun = (findings: any[], success = true): DynamicRunStore => ({
  runs: [{ tool: 'lsan', runId: 'r1', success, findings }],
});

// A typical LSan finding: interceptor frame first, the USER allocation site below.
const finding = (file: string, line: number, fn = 'make_buffer') => ({
  message: `Direct leak of 16 byte(s) in ${file}`,
  stack: [
    { function: '__interceptor_calloc', file: '', line: 0 },
    { function: fn, file, line },
    { function: 'main', file: 'main.c', line: 10 },
  ],
});

describe('synthesizeCandidatesFromStore', () => {
  test('synthesizes one candidate at the user allocation frame (not the interceptor)', () => {
    const cands = synthesizeCandidatesFromStore(lsanRun([finding('src/buf.c', 42)]), pr);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({
      file_path: 'src/buf.c',
      line_number: 42,
      function_name: 'make_buffer',
      allocation_site: 'src/buf.c:42',
      confidence: 'high',
    });
  });

  test('dedupes multiple findings at the same site', () => {
    const cands = synthesizeCandidatesFromStore(lsanRun([finding('a.c', 5), finding('a.c', 5), finding('b.c', 9)]), pr);
    expect(cands.map((c) => c.allocation_site).sort()).toEqual(['a.c:5', 'b.c:9']);
  });

  test('ignores unsuccessful runs', () => {
    expect(synthesizeCandidatesFromStore(lsanRun([finding('a.c', 5)], false), pr)).toEqual([]);
  });

  test('skips findings with no resolvable user frame', () => {
    const noFrame = { message: 'leak', stack: [{ function: '__interceptor_calloc', file: '', line: 0 }] };
    expect(synthesizeCandidatesFromStore(lsanRun([noFrame]), pr)).toEqual([]);
  });

  test('uses an explicit finding location when present (over the stack)', () => {
    const explicit = { file_path: 'x.c', line_number: 7, function_name: 'alloc_thing', stack: [] };
    const cands = synthesizeCandidatesFromStore(lsanRun([explicit]), pr);
    expect(cands[0]).toMatchObject({ file_path: 'x.c', line_number: 7, function_name: 'alloc_thing' });
  });
});
