import { describe, expect, test, afterEach } from 'bun:test';
import { resolveProvider, loadConfig } from './config';
import { toProviderSettings } from './orchestrator/toolWrappers';
import { getEndpointField, setEndpointField } from './surfaces/tui/components/ConfigScreen';

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

describe('toProviderSettings', () => {
  test('maps openai-compat → openai (agent-core routes it through the OpenAI chat path)', () => {
    const cfg = loadConfig({ provider: 'openai-compat', llm: { baseUrl: 'http://x/v1', model: 'm', apiKey: 'k' } });
    const s = toProviderSettings(cfg);
    expect(s.provider).toBe('openai');
    expect(s).toMatchObject({ baseUrl: 'http://x/v1', model: 'm', apiKey: 'k' });
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
