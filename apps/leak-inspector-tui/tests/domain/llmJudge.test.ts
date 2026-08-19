import { describe, expect, test } from 'vitest';
import { isBorderline, shouldEscalate, judgeBundleWithLlm, parseVerdict } from '../../src/domain/llmJudge';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '@cleak/common/types';
import { QuotaExhaustedError } from '@cleak/common/analysis/judge-shared';
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
  test('a CONFIRMED_LEAK double-checked by Stage B2 (verifyConfirmedLeaks) and found clean escalates via dynamicCoverage directly', () => {
    // The exact shape stageTargetedHarness's widened gate produces: no correlated
    // evidence yet, but dynamicCoverage stamped 'exercised_clean' by the targeted
    // harness run itself (computeDynamicCoverage), not via the evidence-array fallback.
    const b = bundleWith(verdict(InvestigationVerdict.CONFIRMED_LEAK, 0.92));
    b.dynamicCoverage = 'exercised_clean';
    expect(shouldEscalate(b)).toBe(true);
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

  test('rethrows QuotaExhaustedError on a quota/rate-limit failure, instead of keeping the heuristic', async () => {
    const callModel: CallModel = async () => {
      throw Object.assign(new Error('LLM error 429: rate limit exceeded'), { status: 429 });
    };
    await expect(judgeBundleWithLlm(bundle(), {}, callModel)).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  test('any other structured-status failure ALSO rethrows as QuotaExhaustedError (broadened scope: any persistent judge-call failure pauses, not just literal quota)', async () => {
    const callModel: CallModel = async () => {
      throw Object.assign(new Error('LLM error 500: internal error'), { status: 500 });
    };
    await expect(judgeBundleWithLlm(bundle(), {}, callModel)).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  test("a deliberate cancellation ('interrupted') still returns null — not a provider failure, must not pause the run", async () => {
    const callModel: CallModel = async () => {
      throw new Error('interrupted');
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

// ── task-5 regression: unpaired static alloc→free must not be exculpated by a
//    confident LLM verdict on a clean-dynamic-only run (class-(b) judge hardening) ──

/** The exact class-(b) shape (triage #14/#27): static pair table marks the
 *  allocation status='unpaired', ownership evidence absent, dynamic run clean
 *  (exercised_clean) but no correlated evidence entry. */
function classBStaticContext(unpairedAllocs: Array<{ variable: string; allocLine: number }> = []) {
  return {
    allocFreePairs: unpairedAllocs.length
      ? unpairedAllocs.map((a) => ({ variable: a.variable, allocCall: 'malloc', allocLine: a.allocLine, freeLine: null, status: 'unpaired' }))
      : [{ variable: 'xoauth', allocCall: 'aprintf', allocLine: 519, freeLine: null, status: 'unpaired' }],
    feasibleLeakPaths: [],
    ownership: { ownershipType: 'unknown' },
  };
}

describe('judgeBundleWithLlm — judge-hardening for unpaired static evidence (task-5)', () => {
  test('a confident LLM false_positive does NOT survive an unpaired alloc→free at the site + clean run (≥ uncertain)', async () => {
    const callModel: CallModel = async () => ({
      text: '{"verdict":"false_positive","confidence":0.96,"explanation":"handed to the caller through outptr, transferring ownership; no leak"}',
      toolUses: [],
      stopReason: 'stop',
    });
    const b = bundle();
    b.evidence = [cleanEv()];
    b.dynamicCoverage = 'exercised_clean';
    const v = await judgeBundleWithLlm(b, classBStaticContext(), callModel);
    expect(v).not.toBeNull();
    expect(['uncertain', InvestigationVerdict.LIKELY_LEAK, InvestigationVerdict.CONFIRMED_LEAK]).toContain(v!.verdict);
  });

  test('multiple unpaired allocations at the site (cjson case) also survive the guard', async () => {
    const callModel: CallModel = async () => ({
      text: '{"verdict":"false_positive","confidence":0.95,"explanation":"duplication returns a new object by contract"}',
      toolUses: [],
      stopReason: 'stop',
    });
    const b = bundle();
    b.dynamicCoverage = 'exercised_clean';
    const ctx = classBStaticContext([
      { variable: 'newitem->valuestring', allocLine: 2147 },
      { variable: 'newitem->string', allocLine: 2156 },
      { variable: 'newchild', allocLine: 2172 },
    ]);
    const v = await judgeBundleWithLlm(b, ctx, callModel);
    expect(v).not.toBeNull();
    expect(['uncertain', InvestigationVerdict.LIKELY_LEAK, InvestigationVerdict.CONFIRMED_LEAK]).toContain(v!.verdict);
  });

  test('existing verdict preserved when the allocation IS paired (exculpatory LLM verdicts stay)', async () => {
    const callModel: CallModel = async () => ({
      text: '{"verdict":"false_positive","confidence":0.9,"explanation":"freed on all paths"}',
      toolUses: [],
      stopReason: 'stop',
    });
    const b = bundle();
    const ctx = {
      allocFreePairs: [{ variable: 'p', allocCall: 'malloc', allocLine: 10, freeLine: 42, status: 'paired' }],
      feasibleLeakPaths: [],
      ownership: { ownershipType: 'scoped', ownershipCarrier: { kind: 'none' } },
    };
    const v = await judgeBundleWithLlm(b, ctx, callModel);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe(InvestigationVerdict.FALSE_POSITIVE);
  });

  test('existing-behavior preserved for a clean run that exercises THIS allocation with correlated evidence and paired static', async () => {
    const callModel: CallModel = async () => ({
      text: '{"verdict":"likely_false_positive","confidence":0.8,"explanation":"exercised and clean; ownership to parameter"}',
      toolUses: [],
      stopReason: 'stop',
    });
    const b = bundle();
    b.evidence = [ev({ leakKind: null, severity: 'info', correlatedToCandidate: true })];
    const ctx = {
      allocFreePairs: [{ variable: 'p', allocCall: 'alloc', allocLine: 10, freeLine: 99, status: 'paired' }],
      feasibleLeakPaths: [],
      ownership: { ownershipType: 'scoped', ownershipCarrier: { kind: 'none' } },
    };
    const v = await judgeBundleWithLlm(b, ctx, callModel);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe(InvestigationVerdict.LIKELY_FALSE_POSITIVE);
  });

  test('exculpation preserved when ownership IS transferred even with an unpaired pair (guard skips on carrier)', async () => {
    const callModel: CallModel = async () => ({
      text: '{"verdict":"false_positive","confidence":0.9,"explanation":"returned to caller via ownership carrier"}',
      toolUses: [],
      stopReason: 'stop',
    });
    const b = bundle();
    const ctx = {
      allocFreePairs: [{ variable: 'copy', allocCall: 'strdup', allocLine: 13, freeLine: null, status: 'unpaired' }],
      feasibleLeakPaths: [],
      ownershipSummary: { role: 'allocator', ownershipCarrier: { kind: 'return_value', name: 'copy' }, rationale: 'return copy' },
    };
    const v = await judgeBundleWithLlm(b, ctx, callModel);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe(InvestigationVerdict.FALSE_POSITIVE);
  });
});

describe('judgeBundleWithLlm — correlated dynamic leak guard (independent of static context)', () => {
  test('a confident LLM false_positive does NOT survive a correlated dynamic leak, even with NO static context at all', async () => {
    // Previously the guard bailed out entirely (`if (!staticContext) return llmVerdict`)
    // whenever enrichment failed for this candidate — silently letting a
    // dynamically-confirmed leak get dismissed on exactly the candidates with the
    // weakest static evidence.
    const callModel: CallModel = async () => ({
      text: '{"verdict":"false_positive","confidence":0.95,"explanation":"looks scoped, no leak"}',
      toolUses: [],
      stopReason: 'stop',
    });
    const b = bundle();
    b.evidence = [leakEv(true)];
    b.dynamicCoverage = 'exercised_leak';
    const v = await judgeBundleWithLlm(b, undefined as any, callModel);
    expect(v).not.toBeNull();
    expect(v!.verdict).not.toBe(InvestigationVerdict.FALSE_POSITIVE);
    expect(v!.verdict).not.toBe(InvestigationVerdict.LIKELY_FALSE_POSITIVE);
  });

  test('NO REGRESSION: an uncorrelated / no dynamic evidence + no static context leaves the LLM verdict alone', async () => {
    const callModel: CallModel = async () => ({
      text: '{"verdict":"false_positive","confidence":0.9,"explanation":"scoped, freed on all paths"}',
      toolUses: [],
      stopReason: 'stop',
    });
    const b = bundle();
    b.evidence = [];
    const v = await judgeBundleWithLlm(b, undefined as any, callModel);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe(InvestigationVerdict.FALSE_POSITIVE);
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
