import { describe, expect, test, vi } from 'vitest';

const loadConfig = vi.fn();
const setConfigKey = vi.fn();

vi.mock('@cleak/config', () => ({ loadConfig: (...a: unknown[]) => loadConfig(...a), setConfigKey: (...a: unknown[]) => setConfigKey(...a) }));

const { currentProviderSummary, persistEndpointOverride } = await import('../providerSetup');

describe('currentProviderSummary', () => {
  test('never leaks the raw api key — only whether one is set', () => {
    loadConfig.mockReturnValue({ llm: { baseUrl: 'https://api.openai.com', model: 'gpt-5', apiKey: 'sk-super-secret' } });
    const summary = currentProviderSummary('openai');
    expect(summary).toEqual({ baseUrl: 'https://api.openai.com', model: 'gpt-5', apiKeySet: true });
    expect(JSON.stringify(summary)).not.toContain('sk-super-secret');
    expect(loadConfig).toHaveBeenCalledWith({ provider: 'openai' });
  });

  test('empty strings surface as undefined, not falsy garbage', () => {
    loadConfig.mockReturnValue({ llm: { baseUrl: '', model: '', apiKey: '' } });
    expect(currentProviderSummary('local')).toEqual({ baseUrl: undefined, model: undefined, apiKeySet: false });
  });
});

describe('persistEndpointOverride', () => {
  test('delegates to setConfigKey with the dotted endpoints path', () => {
    setConfigKey.mockReturnValue('ok');
    persistEndpointOverride('openai-compat', 'baseUrl', 'http://localhost:1234');
    expect(setConfigKey).toHaveBeenCalledWith('endpoints.openai-compat.baseUrl', 'http://localhost:1234');
  });

  test('supports all three editable fields', () => {
    persistEndpointOverride('anthropic', 'model', 'claude-opus-5');
    persistEndpointOverride('anthropic', 'apiKey', 'sk-ant-x');
    expect(setConfigKey).toHaveBeenCalledWith('endpoints.anthropic.model', 'claude-opus-5');
    expect(setConfigKey).toHaveBeenCalledWith('endpoints.anthropic.apiKey', 'sk-ant-x');
  });
});
