import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CallModel } from '@cleak/agent-core';
import { parseStrategyPlan, fallbackPlan, gatherRepoMetadata, decideStrategy, type RepoMetadata } from '../../src/domain/strategist';

const mockModel = (text: string): CallModel =>
  (async () => ({ text, toolUses: [], usage: { inputTokens: 0, outputTokens: 0 } })) as unknown as CallModel;

describe('parseStrategyPlan', () => {
  test('clean JSON', () => {
    const r = parseStrategyPlan('{"runDynamic":true,"judge":"consensus","staticDepth":"full"}');
    expect(r.ok && r.value.judge).toBe('consensus');
  });
  test('JSON in prose', () => {
    const r = parseStrategyPlan('Plan:\n{"runDynamic":false,"judge":"single","staticDepth":"shallow"}\nok');
    expect(r.ok && r.value.runDynamic).toBe(false);
  });
  test('bad enum → not ok', () => {
    expect(parseStrategyPlan('{"runDynamic":true,"judge":"maybe","staticDepth":"full"}').ok).toBe(false);
  });
});

describe('fallbackPlan', () => {
  const meta = (o: Partial<RepoMetadata>): RepoMetadata => ({ fileCount: 5, cppRatio: 0, buildSystem: [], smartPtrDensity: 0, ...o });
  test('no build system → runDynamic false', () => {
    expect(fallbackPlan(meta({ buildSystem: [] })).runDynamic).toBe(false);
  });
  test('build system → runDynamic true', () => {
    expect(fallbackPlan(meta({ buildSystem: ['Makefile'] })).runDynamic).toBe(true);
  });
  test('many files → full depth; few → shallow', () => {
    expect(fallbackPlan(meta({ fileCount: 50 })).staticDepth).toBe('full');
    expect(fallbackPlan(meta({ fileCount: 4 })).staticDepth).toBe('shallow');
  });
  test('C++ / smart-ptr heavy → consensus', () => {
    expect(fallbackPlan(meta({ cppRatio: 0.9 })).judge).toBe('consensus');
  });
});

describe('gatherRepoMetadata + decideStrategy', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'strat-'));
    writeFileSync(join(repo, 'CMakeLists.txt'), 'project(x)');
    writeFileSync(join(repo, 'a.c'), 'int x;');
    writeFileSync(join(repo, 'b.cpp'), 'auto p = std::make_unique<int>();');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test('metadata detects build system, C++ ratio, smart-ptr', () => {
    const m = gatherRepoMetadata(repo);
    expect(m.buildSystem).toContain('CMakeLists.txt');
    expect(m.cppRatio).toBeGreaterThan(0);
    expect(m.smartPtrDensity).toBeGreaterThan(0);
  });
  test('decideStrategy returns the model plan', async () => {
    const plan = await decideStrategy(repo, mockModel('{"runDynamic":true,"judge":"single","staticDepth":"full"}'));
    expect(plan.staticDepth).toBe('full');
  });
  test('decideStrategy falls back deterministically on a model failure', async () => {
    const failing = (async () => { throw new Error('boom'); }) as unknown as CallModel;
    const plan = await decideStrategy(repo, failing);
    expect(plan.runDynamic).toBe(true); // CMakeLists present → fallback runDynamic true
    expect(plan.rationale).toContain('fallback');
  });
});
