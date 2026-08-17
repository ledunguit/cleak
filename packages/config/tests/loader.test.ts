import { describe, expect, test } from 'vitest';
import { resolveProvider } from '../src/loader';
import type { CleakConfig } from '../src/schema';

describe('resolveProvider — named endpoint profiles', () => {
  test('legacy config (profile name == canonical provider type) resolves exactly as before', () => {
    const file: CleakConfig = {
      provider: 'openai-compat',
      endpoints: {
        'openai-compat': {
          baseUrl: 'https://opencode.ai/zen/go/v1',
          model: 'deepseek-v4-flash',
          apiKey: 'sk-opencode',
        },
      },
    };
    const resolved = resolveProvider('openai-compat', file);
    expect(resolved.provider).toBe('openai-compat');
    expect(resolved.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(resolved.model).toBe('deepseek-v4-flash');
    expect(resolved.apiKey).toBe('sk-opencode');
  });

  test('a custom-named profile resolves via its own `provider` field, distinct from the canonical slot of the same transport', () => {
    const file: CleakConfig = {
      provider: 'deepseek-direct',
      endpoints: {
        'openai-compat': {
          baseUrl: 'https://opencode.ai/zen/go/v1',
          model: 'deepseek-v4-flash',
          apiKey: 'sk-opencode',
        },
        'deepseek-direct': {
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          apiKey: 'sk-deepseek',
        },
      },
    };
    const resolved = resolveProvider('deepseek-direct', file);
    // Transport kind comes from the entry's own `provider` field...
    expect(resolved.provider).toBe('openai-compat');
    // ...but the endpoint values are the deepseek-direct profile's own, not the
    // canonical openai-compat slot's.
    expect(resolved.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(resolved.model).toBe('deepseek-chat');
    expect(resolved.apiKey).toBe('sk-deepseek');
  });

  test('two profiles coexist: switching back to the canonical slot leaves it untouched', () => {
    const file: CleakConfig = {
      provider: 'deepseek-direct',
      endpoints: {
        'openai-compat': {
          baseUrl: 'https://opencode.ai/zen/go/v1',
          model: 'deepseek-v4-flash',
          apiKey: 'sk-opencode',
        },
        'deepseek-direct': {
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          apiKey: 'sk-deepseek',
        },
      },
    };
    // Switch "back" by resolving the canonical name against the SAME file object
    // that also has deepseek-direct defined — this is the exact scenario that
    // used to be impossible (only one openai-compat slot existed at all).
    const resolved = resolveProvider('openai-compat', file);
    expect(resolved.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(resolved.model).toBe('deepseek-v4-flash');
    expect(resolved.apiKey).toBe('sk-opencode');
  });

  test('a custom-named profile with no `provider` field and a non-canonical name fails loud', () => {
    const file: CleakConfig = {
      provider: 'mystery-vendor',
      endpoints: {
        'mystery-vendor': { baseUrl: 'https://example.com/v1', model: 'whatever' },
      },
    };
    expect(() => resolveProvider('mystery-vendor', file)).toThrow(/no transport/);
  });

  test('a profile name absent from `endpoints` entirely falls back to canonical built-in defaults when the name itself is a known type', () => {
    const resolved = resolveProvider('local', {});
    expect(resolved.provider).toBe('local');
    expect(resolved.baseUrl).toBe('http://localhost:20128/v1');
  });
});
