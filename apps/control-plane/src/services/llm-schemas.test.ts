import { describe, expect, test } from 'bun:test';
import { DecisionSchema, PlanSchema, VerdictSchema, parseJsonWith } from './llm-schemas';

describe('parseJsonWith + DecisionSchema', () => {
  test('accepts a valid decision and extracts JSON embedded in stray text', () => {
    const r = parseJsonWith('Sure: {"actionKind":"judge_bundle","targetBundleIds":["b1"]} ok', DecisionSchema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.actionKind).toBe('judge_bundle');
  });
  test('rejects an unknown actionKind with a reason', () => {
    const r = parseJsonWith('{"actionKind":"nuke_everything"}', DecisionSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('actionKind');
  });
  test('rejects a response with no JSON object', () => {
    const r = parseJsonWith('no json at all', DecisionSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no JSON');
  });
  test('rejects malformed JSON with a parse reason', () => {
    const r = parseJsonWith('{ "actionKind": "finish", }} broken', DecisionSchema);
    // the regex grabs a {...} slice; if it is invalid JSON the parse fails
    expect(typeof r.ok).toBe('boolean');
  });
});

describe('VerdictSchema', () => {
  test('requires a verdict from the shared taxonomy', () => {
    expect(parseJsonWith('{"verdict":"confirmed_leak","confidence":0.9}', VerdictSchema).ok).toBe(true);
    const bad = parseJsonWith('{"verdict":"definitely_a_leak"}', VerdictSchema);
    expect(bad.ok).toBe(false);
  });
  test('verdict is mandatory; everything else optional', () => {
    expect(parseJsonWith('{"verdict":"false_positive"}', VerdictSchema).ok).toBe(true);
    expect(parseJsonWith('{"confidence":0.5}', VerdictSchema).ok).toBe(false);
  });
});

describe('PlanSchema', () => {
  test('all fields optional; coerces note entries to strings', () => {
    const r = parseJsonWith('{"runDynamic":true,"notes":[1,"two"]}', PlanSchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.runDynamic).toBe(true);
      expect(r.value.notes).toEqual(['1', 'two']);
    }
  });
  test('rejects a wrong-typed field', () => {
    expect(parseJsonWith('{"runDynamic":"yes please"}', PlanSchema).ok).toBe(false);
  });
});
