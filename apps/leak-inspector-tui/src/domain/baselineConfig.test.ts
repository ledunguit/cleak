import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateCapabilities,
  loadBaselineConfig,
  loadBaselineConfigs,
  type Capabilities,
} from './baselineConfig';

const BASELINES_DIR = join(import.meta.dir, '../../../../configs/baselines');

const caps = (over: Partial<Capabilities>): Capabilities => ({
  static: false,
  dynamic: false,
  planner: false,
  tool_selector: false,
  fusion: false,
  ...over,
});

describe('validateCapabilities', () => {
  test('static-only is legal', () => {
    expect(validateCapabilities(caps({ static: true }))).toEqual([]);
  });

  test('nothing-to-detect is rejected', () => {
    expect(validateCapabilities(caps({}))).toHaveLength(1);
    expect(validateCapabilities(caps({}))[0]).toContain('at least one of');
  });

  test('tool_selector without fusion is rejected', () => {
    const errs = validateCapabilities(caps({ static: true, tool_selector: true }));
    expect(errs.some((e) => e.includes('`tool_selector` requires `fusion`'))).toBe(true);
  });

  test('planner without fusion is rejected', () => {
    const errs = validateCapabilities(caps({ static: true, planner: true }));
    expect(errs.some((e) => e.includes('`planner` requires `fusion`'))).toBe(true);
  });

  test('full adaptive is legal', () => {
    expect(
      validateCapabilities(
        caps({ static: true, dynamic: true, planner: true, tool_selector: true, fusion: true }),
      ),
    ).toEqual([]);
  });
});

describe('loadBaselineConfigs (the 9 committed configs)', () => {
  const configs = loadBaselineConfigs(BASELINES_DIR);

  test('loads exactly the 9 ablation baselines', () => {
    expect(configs.map((c) => c.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B6a', 'B6b', 'B7']);
  });

  test('every committed config satisfies the validity rules', () => {
    for (const c of configs) expect(validateCapabilities(c.capabilities)).toEqual([]);
  });

  test('fusion configs carry runs>1 for variance; deterministic ones do not', () => {
    for (const c of configs) {
      if (c.capabilities.fusion) expect(c.runs ?? 1).toBeGreaterThan(1);
      else expect(c.runs ?? 1).toBe(1);
    }
  });

  test('the capability matrix matches the design table', () => {
    const vec = (c: { capabilities: Capabilities }) =>
      [
        c.capabilities.static,
        c.capabilities.dynamic,
        c.capabilities.planner,
        c.capabilities.tool_selector,
        c.capabilities.fusion,
      ]
        .map((b) => (b ? 1 : 0))
        .join('');
    const byId = Object.fromEntries(configs.map((c) => [c.id, vec(c)]));
    expect(byId).toEqual({
      B1: '10000',
      B2: '01000',
      B3: '11000',
      B4: '10001',
      B5: '01001',
      B6: '11001',
      B6a: '11101',
      B6b: '11011',
      B7: '11111',
    });
  });
});

describe('loadBaselineConfig (rejection paths)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleak-baseline-'));
  const writeYaml = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body, 'utf-8');
    return p;
  };

  test('rejects planner without fusion', () => {
    const p = writeYaml(
      'bad-planner.yaml',
      'id: X\nname: bad\ncapabilities: {static: true, dynamic: true, planner: true, tool_selector: false, fusion: false}\n',
    );
    expect(() => loadBaselineConfig(p)).toThrow(/planner.*requires.*fusion/i);
  });

  test('rejects nothing-to-detect', () => {
    const p = writeYaml(
      'bad-empty.yaml',
      'id: X\nname: bad\ncapabilities: {static: false, dynamic: false, planner: false, tool_selector: false, fusion: false}\n',
    );
    expect(() => loadBaselineConfig(p)).toThrow(/at least one of/i);
  });

  test('rejects runs>1 on a deterministic config', () => {
    const p = writeYaml(
      'bad-runs.yaml',
      'id: X\nname: bad\nruns: 3\ncapabilities: {static: true, dynamic: false, planner: false, tool_selector: false, fusion: false}\n',
    );
    expect(() => loadBaselineConfig(p)).toThrow(/runs.*meaningless/i);
  });

  test('rejects malformed YAML', () => {
    const p = writeYaml('bad-yaml.yaml', 'id: X\n  : : :\n');
    expect(() => loadBaselineConfig(p)).toThrow(/not valid YAML/i);
  });
});
