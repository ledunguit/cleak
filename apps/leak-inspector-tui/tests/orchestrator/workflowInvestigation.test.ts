/**
 * `stageHybridJudge`'s quota-exhaustion policy decision — the one piece of the
 * pause-on-quota-exhaustion feature not already covered by
 * `llmJudge.test.ts` (the throw-site) or `evalHarness.test.ts` (the
 * status/cache/breaker integration via a mocked `runHeadless`). This closes
 * the gap in between: does `stageHybridJudge` itself correctly propagate vs.
 * swallow a `QuotaExhaustedError` depending on `cfg.llm.pauseOnQuotaExhausted`?
 */
import { describe, expect, test } from 'vitest';
import { stageHybridJudge, type WorkflowMutableState } from '../../src/orchestrator/workflowInvestigation';
import { createDynamicRunStore } from '../../src/domain/dynamicEvidence';
import { StepLog } from '../../src/domain/stepLog';
import { QuotaExhaustedError } from '@cleak/common/analysis/judge-shared';
import { InvestigationVerdict, ToolKind, type LeakBundle } from '@cleak/common/types';
import type { CallModel } from '@cleak/agent-core';
import type { RunConfig } from '@cleak/config';
import type { InvestigationContext } from '../../src/orchestrator/investigation';

function borderlineBundle(id = 'b1'): LeakBundle {
  return {
    bundleId: id,
    candidate: {
      id: '',
      function_name: 'session_open',
      file_path: '/nonexistent/session.c',
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
    // 'uncertain' is always borderline (isBorderline → shouldEscalate → true),
    // regardless of confidence — guarantees this bundle reaches the judge.
    verdict: { verdict: InvestigationVerdict.UNCERTAIN, confidence: 0.5, explanation: '', evidence: [], tool: ToolKind.HEURISTIC },
  };
}

/** Minimal cfg — only the fields stageHybridJudge actually reads.
 * judgeCache disabled to avoid any disk I/O in the test. */
function cfg(pauseOnQuotaExhausted: boolean): RunConfig {
  return {
    consensus: { n: 1, rule: 'weighted', temperature: 0.7, concurrency: 3, earlyStop: false },
    workflow: { judgeConcurrency: 3 } as any,
    judgeCache: { enabled: false, maxEntries: 0 },
    llm: { judgeTemperature: 0, pauseOnQuotaExhausted } as any,
  } as unknown as RunConfig;
}

function ctx(): InvestigationContext {
  return { repoPath: '/tmp', emitter: undefined, staticClient: undefined } as unknown as InvestigationContext;
}

function state(): WorkflowMutableState {
  return {
    staticStore: new Map(),
    dynStore: createDynamicRunStore(),
    usage: { inputTokens: 0, outputTokens: 0 },
    truncatedCalls: 0,
    transcripts: [],
    decisions: [],
    stepLog: new StepLog(),
    totalTurns: 0,
  };
}

const quotaCallModel: CallModel = async () => {
  throw Object.assign(new Error('LLM error 429: rate limit exceeded'), { status: 429 });
};

describe('stageHybridJudge — quota-exhaustion policy', () => {
  test('pauseOnQuotaExhausted:true (default) — propagates QuotaExhaustedError, aborting the stage', async () => {
    const notices: string[] = [];
    await expect(
      stageHybridJudge([borderlineBundle()], new Map(), cfg(true), ctx(), quotaCallModel, (t) => notices.push(t), state()),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  test('pauseOnQuotaExhausted:false — swallows to the heuristic verdict, does NOT throw', async () => {
    const notices: string[] = [];
    const bundle = borderlineBundle();
    const heuristicVerdict = bundle.verdict;
    await expect(stageHybridJudge([bundle], new Map(), cfg(false), ctx(), quotaCallModel, (t) => notices.push(t), state())).resolves.toBeUndefined();
    // Bundle keeps its pre-existing heuristic verdict — never silently
    // replaced by a fabricated LLM-looking one.
    expect(bundle.verdict).toBe(heuristicVerdict);
    expect(notices.some((n) => n.includes('failed persistently') && n.includes('keeping heuristic'))).toBe(true);
  });

  test('a non-quota error still propagates regardless of the flag (unchanged prior behavior)', async () => {
    const genericFailModel: CallModel = async () => {
      throw new Error('gateway down');
    };
    // judgeBundleWithLlm swallows non-quota errors internally and returns null
    // (see llmJudge.test.ts) — so this must resolve, not throw either way.
    await expect(stageHybridJudge([borderlineBundle()], new Map(), cfg(false), ctx(), genericFailModel, () => {}, state())).resolves.toBeUndefined();
    await expect(stageHybridJudge([borderlineBundle()], new Map(), cfg(true), ctx(), genericFailModel, () => {}, state())).resolves.toBeUndefined();
  });
});

describe('stageHybridJudge — batch judging (single-shot and consensus, round-batched)', () => {
  test('N borderline bundles → ONE callModel call, all get an LLM verdict', async () => {
    let callCount = 0;
    const batchModel: CallModel = async () => {
      callCount++;
      return {
        text: JSON.stringify([
          { id: 'b1', verdict: 'confirmed_leak', confidence: 0.9 },
          { id: 'b2', verdict: 'false_positive', confidence: 0.8 },
          { id: 'b3', verdict: 'likely_leak', confidence: 0.7 },
        ]),
        toolUses: [],
        stopReason: 'stop',
      };
    };
    const bundles = [borderlineBundle('b1'), borderlineBundle('b2'), borderlineBundle('b3')];
    await stageHybridJudge(bundles, new Map(), cfg(true), ctx(), batchModel, () => {}, state());
    expect(callCount).toBe(1);
    expect(bundles[0].verdict?.verdict).toBe(InvestigationVerdict.CONFIRMED_LEAK);
    expect(bundles[1].verdict?.verdict).toBe(InvestigationVerdict.FALSE_POSITIVE);
    expect(bundles[2].verdict?.verdict).toBe(InvestigationVerdict.LIKELY_LEAK);
  });

  test('more bundles than the batch size split into multiple calls', async () => {
    let callCount = 0;
    const batchModel: CallModel = async (req) => {
      callCount++;
      // Echo back a confirmed_leak for every candidate id mentioned in THIS
      // call's prompt — proves each call only carries its own chunk.
      const ids = [...(req.messages[0].content as string).matchAll(/id: (b\d+)/g)].map((m) => m[1]);
      return { text: JSON.stringify(ids.map((id) => ({ id, verdict: 'confirmed_leak', confidence: 0.9 }))), toolUses: [], stopReason: 'stop' };
    };
    const bundles = Array.from({ length: 13 }, (_, i) => borderlineBundle(`b${i}`));
    await stageHybridJudge(bundles, new Map(), cfg(true), ctx(), batchModel, () => {}, state());
    // JUDGE_BATCH_SIZE is 12 → 13 bundles split into 2 calls (12 + 1).
    expect(callCount).toBe(2);
    expect(bundles.every((b) => b.verdict?.verdict === InvestigationVerdict.CONFIRMED_LEAK)).toBe(true);
  });

  test('consensus (n>1) is round-batched — N bundles in one round fit in one call, repeated per sample round', async () => {
    let callCount = 0;
    const batchModel: CallModel = async (req) => {
      callCount++;
      const ids = [...(req.messages[0].content as string).matchAll(/id: (b\d+)/g)].map((m) => m[1]);
      return { text: JSON.stringify(ids.map((id) => ({ id, verdict: 'confirmed_leak', confidence: 0.9 }))), toolUses: [], stopReason: 'stop' };
    };
    const consensusCfg: RunConfig = { ...cfg(true), consensus: { n: 3, rule: 'weighted', temperature: 0.7, concurrency: 3, earlyStop: false } } as RunConfig;
    const bundles = [borderlineBundle('b1'), borderlineBundle('b2')];
    await stageHybridJudge(bundles, new Map(), consensusCfg, ctx(), batchModel, () => {}, state());
    // 2 bundles fit within JUDGE_BATCH_SIZE(=12) → one batch call per round;
    // n=3 samples/bundle, earlyStop off → 3 rounds → 3 calls total, not 6.
    expect(callCount).toBe(3);
    expect(bundles[0].verdict?.verdict).toBe(InvestigationVerdict.CONFIRMED_LEAK);
    expect(bundles[1].verdict?.verdict).toBe(InvestigationVerdict.CONFIRMED_LEAK);
  });

  test('consensus round-batching splits an over-sized active set into multiple per-round calls', async () => {
    let callCount = 0;
    const batchModel: CallModel = async (req) => {
      callCount++;
      const ids = [...(req.messages[0].content as string).matchAll(/id: (b\d+)/g)].map((m) => m[1]);
      return { text: JSON.stringify(ids.map((id) => ({ id, verdict: 'confirmed_leak', confidence: 0.9 }))), toolUses: [], stopReason: 'stop' };
    };
    const consensusCfg: RunConfig = { ...cfg(true), consensus: { n: 2, rule: 'weighted', temperature: 0.7, concurrency: 3, earlyStop: false } } as RunConfig;
    const bundles = Array.from({ length: 13 }, (_, i) => borderlineBundle(`b${i}`));
    await stageHybridJudge(bundles, new Map(), consensusCfg, ctx(), batchModel, () => {}, state());
    // 13 bundles > JUDGE_BATCH_SIZE(=12) → 2 calls/round (12 + 1); n=2 rounds → 4 calls total.
    expect(callCount).toBe(4);
    expect(bundles.every((b) => b.verdict?.verdict === InvestigationVerdict.CONFIRMED_LEAK)).toBe(true);
  });

  test('consensus round-batching with earlyStop drops a locked bundle out of later rounds', async () => {
    let round = 0;
    const seenIdsPerCall: string[][] = [];
    // b1: always confidently confirmed_leak (weight 0.95 each sample) — under the
    // 'weighted' rule this drives minRatio > 0.5 (locked "always flag") after
    // enough samples, since remaining votes can no longer drag the ratio back
    // down to <=0.5 even in the worst case. b2 alternates flag/no-flag at a low,
    // constant confidence so neither bound ever locks — stays active every round.
    const batchModel: CallModel = async (req) => {
      const ids = [...(req.messages[0].content as string).matchAll(/id: (b\d+)/g)].map((m) => m[1]);
      seenIdsPerCall.push(ids);
      const resp = {
        text: JSON.stringify(
          ids.map((id) =>
            id === 'b1'
              ? { id, verdict: 'confirmed_leak', confidence: 0.95 }
              : { id, verdict: round % 2 === 0 ? 'confirmed_leak' : 'false_positive', confidence: 0.5 },
          ),
        ),
        toolUses: [],
        stopReason: 'stop' as const,
      };
      round++;
      return resp;
    };
    const consensusCfg: RunConfig = {
      ...cfg(true),
      consensus: { n: 5, rule: 'weighted', temperature: 0.7, concurrency: 3, earlyStop: true },
    } as RunConfig;
    const bundles = [borderlineBundle('b1'), borderlineBundle('b2')];
    await stageHybridJudge(bundles, new Map(), consensusCfg, ctx(), batchModel, () => {}, state());
    // b1 must stop appearing in later rounds once its remaining samples can no
    // longer flip the weighted decision; b2 (oscillating, never locked) keeps
    // getting sampled every round up to n=5.
    const b1Rounds = seenIdsPerCall.filter((ids) => ids.includes('b1')).length;
    const b2Rounds = seenIdsPerCall.filter((ids) => ids.includes('b2')).length;
    expect(b1Rounds).toBeLessThan(5);
    expect(b2Rounds).toBe(5);
  });
});
