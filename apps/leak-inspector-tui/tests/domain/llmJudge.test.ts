import { describe, expect, test } from 'bun:test';
import { isBorderline, shouldEscalate, judgeBundleWithLlm, parseVerdict } from '../../src/domain/llmJudge';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '@cleak/common/types';
import type { CallModel } from '@cleak/agent-core';

const verdict = (v: InvestigationVerdict, confidence: number): VerdictResult => ({
  verdict: v,
  confidence,
  explanation: '',
  evidence: [],
  tool: ToolKind.HEURISTIC,
});

describe('isBorderline', () => {
  test('likely_leak / uncertain are always borderline', () => {
    expect(isBorderline(verdict(InvestigationVerdict.LIKELY_LEAK, 0.5))).toBe(true);
    expect(isBorderline(verdict(InvestigationVerdict.UNCERTAIN, 0.3))).toBe(true);
  });
  test('confident confirmed / false_positive are NOT borderline', () => {
    expect(isBorderline(verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.92))).toBe(false);
    expect(isBorderline(verdict(InvestigationVerdict.FALSE_POSITIVE, 0.9))).toBe(false);
  });
  test('mid-confidence confirmed/false_positive ARE borderline', () => {
    expect(isBorderline(verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.5))).toBe(true);
  });
});

const ev = (over: Record<string, any> = {}): any => ({
  tool: 'lsan',
  function_name: 'f',
  file_path: 'x.c',
  line_number: 1,
  bytes_lost: 0,
  blocks_lost: 0,
  severity: 'info',
  leakKind: null,
  ...over,
});
const leakEv = (correlated: boolean) => ev({ leakKind: 'definitely_lost', severity: 'high', bytes_lost: 100, correlatedToCandidate: correlated });
const cleanEv = () => ev({ leakKind: null, severity: 'info' });

function bundleWith(v: VerdictResult | undefined, evidence: any[] = []): LeakBundle {
  const b = bundle();
  b.verdict = v;
  b.evidence = evidence;
  return b;
}

describe('shouldEscalate', () => {
  test('no verdict → false', () => {
    expect(shouldEscalate(bundleWith(undefined))).toBe(false);
  });
  test('a borderline verdict always escalates (delegates to isBorderline)', () => {
    expect(shouldEscalate(bundleWith(verdict(InvestigationVerdict.UNCERTAIN, 0.3)))).toBe(true);
  });
  test('dyn-off: a confident flag with NO evidence does NOT escalate (path unchanged)', () => {
    expect(shouldEscalate(bundleWith(verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.92)))).toBe(false);
  });
  test('a confident flag resting on an UN-correlated leak escalates (coarse evidence)', () => {
    expect(shouldEscalate(bundleWith(verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.92), [leakEv(false)]))).toBe(true);
  });
  test('a confident flag contradicted by a CLEAN dynamic run escalates', () => {
    expect(shouldEscalate(bundleWith(verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.92), [cleanEv()]))).toBe(true);
  });
  test('a confident flag backed by a CORRELATED leak does NOT escalate (well-supported)', () => {
    expect(shouldEscalate(bundleWith(verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.92), [leakEv(true)]))).toBe(false);
  });
  test('a confident false_positive contradicted by a CORRELATED leak escalates', () => {
    expect(shouldEscalate(bundleWith(verdict(InvestigationVerdict.FALSE_POSITIVE, 0.9), [leakEv(true)]))).toBe(true);
  });
  test('a confident false_positive with only a clean run does NOT escalate', () => {
    expect(shouldEscalate(bundleWith(verdict(InvestigationVerdict.FALSE_POSITIVE, 0.9), [cleanEv()]))).toBe(false);
  });

  test('confident flag contradicted by static "clean" (ownership handed out) escalates', () => {
    const b = bundleWith(verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.92));
    (b as any).staticEvidence = { ownership: { ownershipCarrier: { kind: 'return_value' } } };
    expect(shouldEscalate(b)).toBe(true);
  });

  test('confident false_positive contradicted by static "leak" (unpaired alloc→free) escalates', () => {
    const b = bundleWith(verdict(InvestigationVerdict.FALSE_POSITIVE, 0.9));
    (b as any).staticEvidence = { allocFreePairs: [{ variable: 'p', allocLine: 1, status: 'unpaired' }] };
    expect(shouldEscalate(b)).toBe(true);
  });
});

function bundle(): LeakBundle {
  return {
    bundleId: 'b1',
    candidate: {
      id: '',
      function_name: 'session_open',
      file_path: '/nonexistent/session.c', // source unavailable → snippet placeholder
      line_number: 8,
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

describe('judgeBundleWithLlm', () => {
  test('parses a JSON verdict and enriches it', async () => {
    const callModel: CallModel = async () => ({
      text: '{"verdict":"confirmed_leak","confidence":0.9,"explanation":"leaks on early return"}',
      toolUses: [],
      stopReason: 'stop',
    });
    const v = await judgeBundleWithLlm(bundle(), { hasExplicitFree: false }, callModel);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe(InvestigationVerdict.CONFIRMED_LEAK);
    expect(v!.confidence).toBe(0.9);
    expect(v!.tool).toBe(ToolKind.LLM);
  });

  test('extracts JSON embedded in stray text', async () => {
    const callModel: CallModel = async () => ({
      text: 'Here is my verdict: {"verdict":"false_positive","confidence":0.8,"explanation":"freed"} done',
      toolUses: [],
      stopReason: 'stop',
    });
    const v = await judgeBundleWithLlm(bundle(), {}, callModel);
    expect(v!.verdict).toBe(InvestigationVerdict.FALSE_POSITIVE);
  });

  test('returns null on unparseable / invalid response', async () => {
    const callModel: CallModel = async () => ({ text: 'no json here', toolUses: [], stopReason: 'stop' });
    expect(await judgeBundleWithLlm(bundle(), {}, callModel)).toBeNull();
  });

  test('returns null when the model call throws', async () => {
    const callModel: CallModel = async () => {
      throw new Error('gateway down');
    };
    expect(await judgeBundleWithLlm(bundle(), {}, callModel)).toBeNull();
  });

  test('onNotice fires with a reason when the verdict is unparseable (no silent fallback)', async () => {
    const notices: string[] = [];
    const callModel: CallModel = async () => ({ text: 'no json here', toolUses: [], stopReason: 'stop' });
    const v = await judgeBundleWithLlm(bundle(), {}, callModel, undefined, undefined, (r) => notices.push(r));
    expect(v).toBeNull();
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('keeping heuristic');
  });
});

describe('parseVerdict (discriminated result)', () => {
  test('valid verdict → ok with clamped confidence', () => {
    const r = parseVerdict('{"verdict":"likely_leak","confidence":1.4,"explanation":"x","evidence":["a",1]}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.verdict).toBe('likely_leak');
      expect(r.value.confidence).toBe(1); // clamped to [0,1]
      expect(r.value.evidence).toEqual(['a', '1']); // coerced to strings
    }
  });
  test('JSON embedded in prose is recovered', () => {
    const r = parseVerdict('verdict: {"verdict":"false_positive","confidence":0.7} ok');
    expect(r.ok).toBe(true);
  });
  test('empty / no-JSON / malformed each report a distinct reason', () => {
    expect(parseVerdict('')).toEqual({ ok: false, reason: 'empty model response' });
    expect(parseVerdict('just prose')).toMatchObject({ ok: false, reason: 'no JSON object in response' });
    expect(parseVerdict('{verdict: oops}')).toMatchObject({ ok: false, reason: 'malformed JSON in response' });
  });
  test('an unknown verdict string is rejected with its value in the reason', () => {
    const r = parseVerdict('{"verdict":"definitely_maybe","confidence":0.5}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('definitely_maybe');
  });
  test('missing confidence defaults to 0.5', () => {
    const r = parseVerdict('{"verdict":"uncertain"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.confidence).toBe(0.5);
  });
});
