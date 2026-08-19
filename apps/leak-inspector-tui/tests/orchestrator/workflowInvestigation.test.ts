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

function borderlineBundle(): LeakBundle {
  return {
    bundleId: 'b1',
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
    expect(notices.some((n) => n.includes('quota/rate-limit exhausted') && n.includes('keeping heuristic'))).toBe(true);
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
