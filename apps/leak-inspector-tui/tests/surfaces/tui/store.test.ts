import { describe, expect, test } from 'bun:test';
import { visibleMessages, visibleFindings } from '../../../src/surfaces/tui/store';
import type { FindingView } from '../../../src/surfaces/tui/findings/findingView';

const fv = (over: Partial<FindingView>): FindingView => ({
  id: 'x',
  function: 'f',
  file: 'a.c',
  line: 1,
  allocationType: 'malloc',
  verdict: 'uncertain',
  confidence: 0.5,
  verdictTool: 'heuristic',
  dynamicCoverage: 'dynamic_off',
  explanation: '',
  evidence: [],
  ...over,
});

const withFindings = (findings: FindingView[], slice: any = {}): any => ({
  findings: { scanId: 's', source: 'live', findings, cursor: 0, sort: 'severity', filter: {}, tab: 'table', ...slice },
});

describe('visibleFindings', () => {
  test('severity sort: confirmed > likely > uncertain, ties broken by confidence', () => {
    const list = [
      fv({ id: 'u', verdict: 'uncertain', confidence: 0.9 }),
      fv({ id: 'c', verdict: 'confirmed_leak', confidence: 0.8 }),
      fv({ id: 'l1', verdict: 'likely_leak', confidence: 0.6 }),
      fv({ id: 'l2', verdict: 'likely_leak', confidence: 0.95 }),
    ];
    expect(visibleFindings(withFindings(list)).map((x) => x.id)).toEqual(['c', 'l2', 'l1', 'u']);
  });

  test('confidence sort ignores verdict severity', () => {
    const list = [fv({ id: 'a', confidence: 0.2 }), fv({ id: 'b', confidence: 0.9 })];
    expect(visibleFindings(withFindings(list, { sort: 'confidence' })).map((x) => x.id)).toEqual(['b', 'a']);
  });

  test('file sort orders by file then line', () => {
    const list = [fv({ id: '1', file: 'b.c', line: 1 }), fv({ id: '2', file: 'a.c', line: 9 }), fv({ id: '3', file: 'a.c', line: 2 })];
    expect(visibleFindings(withFindings(list, { sort: 'file' })).map((x) => x.id)).toEqual(['3', '2', '1']);
  });

  test('verdict + coverage filters narrow the list', () => {
    const list = [
      fv({ id: 'k', verdict: 'confirmed_leak', dynamicCoverage: 'exercised_leak' }),
      fv({ id: 'fp', verdict: 'false_positive', dynamicCoverage: 'exercised_clean' }),
    ];
    expect(visibleFindings(withFindings(list, { filter: { verdict: 'confirmed_leak' } })).map((x) => x.id)).toEqual(['k']);
    expect(visibleFindings(withFindings(list, { filter: { coverage: 'exercised_clean' } })).map((x) => x.id)).toEqual(['fp']);
  });

  test('no findings slice → empty list', () => {
    expect(visibleFindings({} as any)).toEqual([]);
  });

  test('returns a sorted COPY — the source order is not mutated', () => {
    const s = withFindings([fv({ id: 'u', verdict: 'uncertain' }), fv({ id: 'c', verdict: 'confirmed_leak' })]);
    visibleFindings(s);
    expect(s.findings.findings.map((x: any) => x.id)).toEqual(['u', 'c']); // unchanged
  });
});

describe('visibleMessages', () => {
  test('shows only the active agent\'s messages', () => {
    const st: any = {
      viewAgentId: 'static-1',
      messages: [
        { id: '1', agentId: 'main' },
        { id: '2', agentId: 'static-1' },
        { id: '3', agentId: 'static-1' },
        { id: '4', agentId: 'dynamic' },
      ],
    };
    expect(visibleMessages(st).map((m: any) => m.id)).toEqual(['2', '3']);
  });
});
