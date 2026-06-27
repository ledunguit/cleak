import { describe, expect, test, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { resolveProvider, loadConfig, clampConfig } from './config';
import { toProviderSettings } from './orchestrator/toolWrappers';
import { getEndpointField, setEndpointField } from './surfaces/tui/components/ConfigScreen';
import { configFilePath } from './domain/config-file';

// Hermetic config-file location: point XDG at an EMPTY temp dir so loadConfig's
// file layer is empty (env-only behaviour) unless a test writes one explicitly.
const xdgDir = mkdtempSync(join(tmpdir(), 'cleak-xdg-'));
const prevXdg = process.env.XDG_CONFIG_HOME;
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = xdgDir;
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(xdgDir, { recursive: true, force: true });
});
function writeConfigFile(obj: unknown): void {
  const p = configFilePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj), 'utf-8');
}
function clearConfigFile(): void {
  rmSync(configFilePath(), { force: true });
}

const COMPAT_KEYS = ['OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_MODEL', 'OPENAI_COMPAT_API_KEY', 'OPENAI_COMPAT_JSON_MODE'];
const saved: Record<string, string | undefined> = Object.fromEntries(COMPAT_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of COMPAT_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveProvider("openai-compat")', () => {
  test('reads the OPENAI_COMPAT_* env vars', () => {
    process.env.OPENAI_COMPAT_BASE_URL = 'http://localhost:1234/v1';
    process.env.OPENAI_COMPAT_MODEL = 'my-local-model';
    process.env.OPENAI_COMPAT_API_KEY = 'sk-abc';
    expect(resolveProvider('openai-compat')).toMatchObject({
      provider: 'openai-compat',
      baseUrl: 'http://localhost:1234/v1',
      model: 'my-local-model',
      apiKey: 'sk-abc',
      jsonMode: true,
    });
  });
  test('no api.openai.com default — base URL/model are user-supplied (empty when unset)', () => {
    for (const k of COMPAT_KEYS) delete process.env[k];
    const c = resolveProvider('openai-compat');
    expect(c.baseUrl).toBe('');
    expect(c.model).toBe('');
  });
});

describe('loadConfig field-wise llm override', () => {
  test('a partial llm override keeps the env-resolved base URL + key', () => {
    process.env.OPENAI_COMPAT_BASE_URL = 'http://host/v1';
    process.env.OPENAI_COMPAT_API_KEY = 'k';
    const c = loadConfig({ provider: 'openai-compat', llm: { model: 'override-model' } });
    expect(c.llm.model).toBe('override-model');
    expect(c.llm.baseUrl).toBe('http://host/v1'); // not clobbered
    expect(c.llm.apiKey).toBe('k');
  });
  test('undefined override fields never clobber resolved values', () => {
    process.env.OPENAI_COMPAT_MODEL = 'env-model';
    const c = loadConfig({ provider: 'openai-compat', llm: { model: undefined, baseUrl: undefined } });
    expect(c.llm.model).toBe('env-model');
  });
});

describe('clampConfig — hard bounds on fan-out / sampling', () => {
  const baseCfg = () =>
    loadConfig({}); // env-resolved defaults (n=1, temp 0.7, concurrency 3, …)

  test('a runaway consensus.n is clamped to the max', () => {
    const c = baseCfg();
    c.consensus.n = 1000;
    clampConfig(c);
    expect(c.consensus.n).toBe(9);
  });

  test('out-of-range temperature and non-numeric values fall back safely', () => {
    const c = baseCfg();
    c.consensus.temperature = 5;
    c.workflow.staticConcurrency = Number('abc'); // NaN
    clampConfig(c);
    expect(c.consensus.temperature).toBe(2);
    expect(c.workflow.staticConcurrency).toBe(3); // NaN → fallback
  });

  test('in-range values pass through untouched', () => {
    const c = baseCfg();
    c.consensus.n = 3;
    c.consensus.temperature = 0.5;
    c.workflow.judgeConcurrency = 4;
    clampConfig(c);
    expect(c.consensus.n).toBe(3);
    expect(c.consensus.temperature).toBe(0.5);
    expect(c.workflow.judgeConcurrency).toBe(4);
  });

  test('loadConfig already returns clamped values (env CONSENSUS_N respected within bounds)', () => {
    process.env.CONSENSUS_N = '500';
    const c = loadConfig({});
    expect(c.consensus.n).toBe(9);
    delete process.env.CONSENSUS_N;
  });
});

describe('toProviderSettings', () => {
  test('maps openai-compat → openai (agent-core routes it through the OpenAI chat path)', () => {
    const cfg = loadConfig({ provider: 'openai-compat', llm: { baseUrl: 'http://x/v1', model: 'm', apiKey: 'k' } });
    const s = toProviderSettings(cfg);
    expect(s.provider).toBe('openai');
    expect(s).toMatchObject({ baseUrl: 'http://x/v1', model: 'm', apiKey: 'k' });
  });
});

describe('config-file precedence (CLI flag > env > config file > default)', () => {
  afterEach(() => {
    clearConfigFile();
    delete process.env.STATIC_ANALYZER_MCP_URL;
    delete process.env.LLM_PROVIDER;
  });

  test('config file supplies a value when env is unset', () => {
    writeConfigFile({ staticUrl: 'http://file:50061/mcp' });
    expect(loadConfig({}).staticUrl).toBe('http://file:50061/mcp');
  });

  test('env overrides the config file', () => {
    writeConfigFile({ staticUrl: 'http://file:50061/mcp' });
    process.env.STATIC_ANALYZER_MCP_URL = 'http://env:50061/mcp';
    expect(loadConfig({}).staticUrl).toBe('http://env:50061/mcp');
  });

  test('a CLI override beats both env and the file', () => {
    writeConfigFile({ staticUrl: 'http://file:50061/mcp' });
    process.env.STATIC_ANALYZER_MCP_URL = 'http://env:50061/mcp';
    expect(loadConfig({ staticUrl: 'http://flag:50061/mcp' }).staticUrl).toBe('http://flag:50061/mcp');
  });

  test('built-in default applies when neither env nor file set it', () => {
    expect(loadConfig({}).staticUrl).toBe('http://localhost:50061/mcp');
  });

  test('file provides provider + per-provider endpoint + tuning (below env)', () => {
    writeConfigFile({ provider: 'openai', endpoints: { openai: { model: 'gpt-file' } }, maxTurns: 42, consensus: { n: 3 } });
    const c = loadConfig({});
    expect(c.provider).toBe('openai');
    expect(c.llm.model).toBe('gpt-file');
    expect(c.maxTurns).toBe(42);
    expect(c.consensus.n).toBe(3);
  });
});

describe('ConfigScreen per-provider endpoint binding', () => {
  test('get/set are scoped per provider (switching provider keeps each one)', () => {
    let p = { defaultMode: 'llm_assisted', defaultDynamic: 'off', autoShowReport: false } as any;
    p = setEndpointField(p, 'openai-compat', 'baseUrl', 'http://a/v1');
    p = setEndpointField(p, 'openai', 'model', 'gpt-4o');
    expect(getEndpointField(p, 'openai-compat', 'baseUrl')).toBe('http://a/v1');
    expect(getEndpointField(p, 'openai', 'model')).toBe('gpt-4o');
    expect(getEndpointField(p, 'openai-compat', 'model')).toBe(''); // untouched provider field
    expect(getEndpointField(p, 'anthropic', 'apiKey')).toBe(''); // unset provider
  });
});
