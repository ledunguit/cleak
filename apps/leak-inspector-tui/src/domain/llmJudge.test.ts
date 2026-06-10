import { describe, expect, test } from 'bun:test';
import { isBorderline, judgeBundleWithLlm } from './llmJudge';
import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '@mcpvul/common/types';
import type { CallModel } from '@mcpvul/agent-core';

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
});
