import { describe, expect, test } from 'bun:test';
import type { CallModel } from '@cleak/agent-core';
import { clampThresholds, parseTuning, tuneThresholds } from '../../src/domain/judgeTuner';

const mockModel = (text: string): CallModel =>
  (async () => ({ text, toolUses: [], usage: { inputTokens: 0, outputTokens: 0 } })) as unknown as CallModel;

describe('clampThresholds — bounded, never reckless', () => {
  test('in-range values pass', () => {
    expect(clampThresholds({ confirmed: 0.75, likely: 0.45 })).toEqual({ confirmed: 0.75, likely: 0.45 });
  });
  test('too-low confirmed is raised to the floor', () => {
    expect(clampThresholds({ confirmed: 0.2, likely: 0.1 }).confirmed).toBe(0.55);
  });
  test('too-high confirmed is capped', () => {
    expect(clampThresholds({ confirmed: 0.99, likely: 0.5 }).confirmed).toBe(0.85);
  });
  test('inverted (confirmed < likely) is fixed: likely stays below confirmed', () => {
    const t = clampThresholds({ confirmed: 0.6, likely: 0.9 });
    expect(t.likely).toBeLessThan(t.confirmed);
  });
});

describe('parseTuning', () => {
  test('clean + prose-embedded', () => {
    expect(parseTuning('{"confirmed":0.7,"likely":0.4}')).toEqual({ confirmed: 0.7, likely: 0.4 });
    expect(parseTuning('ok\n{"confirmed":0.72,"likely":0.42}\n')).toEqual({ confirmed: 0.72, likely: 0.42 });
  });
  test('garbage → null', () => {
    expect(parseTuning('no')).toBeNull();
  });
});

describe('tuneThresholds', () => {
  test('clamps the model proposal', async () => {
    const t = await tuneThresholds(mockModel('{"confirmed":0.95,"likely":0.5}'));
    expect(t.confirmed).toBe(0.85);
  });
  test('model failure → frozen defaults', async () => {
    const failing = (async () => { throw new Error('boom'); }) as unknown as CallModel;
    expect(await tuneThresholds(failing)).toEqual({ confirmed: 0.7, likely: 0.4 });
  });
});
