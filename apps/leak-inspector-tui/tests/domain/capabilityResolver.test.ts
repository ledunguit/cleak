import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadBaselineConfigs, type Capabilities } from '../../src/domain/baselineConfig';
import { resolveCapabilities, type ResolvedRunPlan } from '../../src/domain/capabilityResolver';

const BASELINES_DIR = join(import.meta.dir, '../../../../configs/baselines');

/** Expected resolution per baseline id (the contract the sweep runner relies on). */
const EXPECTED: Record<string, Partial<ResolvedRunPlan>> = {
  B1: { mode: 'no_llm', dynamic: 'off', strategy: 'off', toolSelect: false, staticDiscovery: true, enrich: false, runs: 1 },
  B2: { mode: 'no_llm', dynamic: 'selective', strategy: 'off', toolSelect: false, staticDiscovery: false, enrich: false, runs: 1 },
  B3: { mode: 'no_llm', dynamic: 'selective', strategy: 'off', toolSelect: false, staticDiscovery: true, enrich: false, runs: 1 },
  B4: { mode: 'llm_assisted', dynamic: 'off', strategy: 'off', toolSelect: false, staticDiscovery: true, enrich: true, consensusN: 1, runs: 3 },
  B5: { mode: 'llm_assisted', dynamic: 'selective', strategy: 'off', toolSelect: false, staticDiscovery: false, enrich: false, consensusN: 1, runs: 3 },
  B6: { mode: 'llm_assisted', dynamic: 'selective', strategy: 'off', toolSelect: false, staticDiscovery: true, enrich: true, consensusN: 1, runs: 3 },
  B6a: { mode: 'llm_assisted', dynamic: 'selective', strategy: 'auto', toolSelect: false, staticDiscovery: true, enrich: true, consensusN: 1, runs: 3 },
  B6b: { mode: 'llm_assisted', dynamic: 'selective', strategy: 'off', toolSelect: true, staticDiscovery: true, enrich: false, consensusN: 1, runs: 3 },
  B7: { mode: 'llm_assisted', dynamic: 'selective', strategy: 'auto', toolSelect: true, staticDiscovery: true, enrich: false, consensusN: 1, runs: 3 },
};

describe('resolveCapabilities (the 9 committed baselines)', () => {
  const configs = loadBaselineConfigs(BASELINES_DIR);

  for (const c of configs) {
    test(`${c.id} resolves to the expected run plan`, () => {
      const plan = resolveCapabilities(c.capabilities, { consensusN: c.consensusN, runs: c.runs });
      expect(plan).toMatchObject(EXPECTED[c.id]);
    });
  }

  test('deterministic baselines (no fusion) never claim consensus or variance runs', () => {
    for (const c of configs) {
      const plan = resolveCapabilities(c.capabilities, { consensusN: c.consensusN, runs: c.runs });
      if (!c.capabilities.fusion) {
        expect(plan.mode).toBe('no_llm');
        expect(plan.consensusN).toBeUndefined();
        expect(plan.runs).toBe(1);
        expect(plan.enrich).toBe(false);
      }
    }
  });

  test('enrich is on iff static && fusion && !tool_selector', () => {
    for (const c of configs) {
      const plan = resolveCapabilities(c.capabilities, {});
      const expected = c.capabilities.static && c.capabilities.fusion && !c.capabilities.tool_selector;
      expect(plan.enrich).toBe(expected);
    }
  });
});

describe('resolveCapabilities (guards)', () => {
  test('throws on an illegal combination', () => {
    expect(() =>
      resolveCapabilities({ static: true, dynamic: false, planner: true, tool_selector: false, fusion: false }),
    ).toThrow(/illegal capability/i);
  });
});

/** Default capabilities (all false) with overrides for compact test setup. */
function caps(over: Partial<Capabilities> = {}): Capabilities {
  return { static: false, dynamic: false, planner: false, tool_selector: false, fusion: false, ...over };
}

describe('resolveCapabilities (edge cases)', () => {
  test('runs = 1 when fusion is off even if opts.runs = 5', () => {
    const plan = resolveCapabilities(caps({ static: true }), { runs: 5 });
    expect(plan.runs).toBe(1);
  });

  test('consensusN = undefined when fusion is off regardless of opts.consensusN', () => {
    const plan = resolveCapabilities(caps({ static: true }), { consensusN: 3 });
    expect(plan.consensusN).toBeUndefined();
  });
});

describe('resolveCapabilities (baseline round-trip)', () => {
  test('every baseline config round-trips through loadBaselineConfig + resolveCapabilities', () => {
    const configs = loadBaselineConfigs(
      join(import.meta.dir, '../../../../configs/baselines'),
    );
    expect(configs.length).toBeGreaterThanOrEqual(9); // B1-B7 + variants
    for (const cfg of configs) {
      const plan = resolveCapabilities(cfg.capabilities, {
        consensusN: cfg.consensusN,
        runs: cfg.runs,
      });
      expect(plan.mode).toBe(cfg.capabilities.fusion ? 'llm_assisted' : 'no_llm');
      if (!cfg.capabilities.fusion) {
        expect(plan.runs).toBe(1);
        expect(plan.consensusN).toBeUndefined();
      }
    }
  });
});
