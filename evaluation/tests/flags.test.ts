import { describe, expect, test } from 'vitest';
import { parseFlags } from '../flags';

describe('parseFlags', () => {
  test('defaults with no argv', () => {
    const f = parseFlags([]);
    expect(f.mode).toBeUndefined();
    expect(f.corpus).toBeUndefined();
    expect(f.dryRun).toBe(false);
    expect(f.verbose).toBe(false);
    expect(f.interactive).toBe(false);
    expect(f.yes).toBe(false);
    expect(f.autoIngest).toBe(false);
    expect(f.setEndpoint).toEqual([]);
    expect(f.help).toBe(false);
  });

  test('positional mode + basic flags', () => {
    const f = parseFlags(['no_llm', '--corpus', 'demo/juliet_cwe401', '--limit', '50']);
    expect(f.mode).toBe('no_llm');
    expect(f.corpus).toBe('demo/juliet_cwe401');
    expect(f.limit).toBe(50);
  });

  test('a leading flag (not a bare word) is never mistaken for the mode positional', () => {
    const f = parseFlags(['--corpus', 'demo/juliet_cwe401']);
    expect(f.mode).toBeUndefined();
  });

  test('--stratify with no value defaults to functionalVariant', () => {
    const f = parseFlags(['--stratify']);
    expect(f.stratify).toBe('functionalVariant');
  });

  test('--stratify with an explicit key keeps it', () => {
    const f = parseFlags(['--stratify', 'cweId']);
    expect(f.stratify).toBe('cweId');
  });

  test('--static-tools none disables all static tools (empty array, not undefined)', () => {
    const f = parseFlags(['--static-tools', 'none']);
    expect(f.staticTools).toEqual([]);
  });

  test('--static-tools comma list is split and trimmed', () => {
    const f = parseFlags(['--static-tools', 'functionSummary, pathConstraints']);
    expect(f.staticTools).toEqual(['functionSummary', 'pathConstraints']);
  });

  test('boolFlag: --enrich / --no-enrich / neither', () => {
    expect(parseFlags(['--enrich']).enrich).toBe(true);
    expect(parseFlags(['--no-enrich']).enrich).toBe(false);
    expect(parseFlags([]).enrich).toBeUndefined();
  });

  test('--set-endpoint is repeatable', () => {
    const f = parseFlags(['--set-endpoint', 'openai.model=gpt-5', '--set-endpoint', 'openai.baseUrl=https://x']);
    expect(f.setEndpoint).toEqual(['openai.model=gpt-5', 'openai.baseUrl=https://x']);
  });

  test('--runs is clamped to a minimum of 1', () => {
    expect(parseFlags(['--runs', '0']).runs).toBe(1);
    expect(parseFlags(['--runs', '5']).runs).toBe(5);
  });

  test('--concurrency is clamped to a minimum of 1', () => {
    expect(parseFlags(['--concurrency', '0']).concurrency).toBe(1);
  });

  test('-y / -v short flags', () => {
    const f = parseFlags(['-y', '-v']);
    expect(f.yes).toBe(true);
    expect(f.verbose).toBe(true);
  });

  test('--help / -h', () => {
    expect(parseFlags(['--help']).help).toBe(true);
    expect(parseFlags(['-h']).help).toBe(true);
    expect(parseFlags([]).help).toBe(false);
  });
});
