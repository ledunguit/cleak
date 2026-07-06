import { describe, expect, test, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  loadConfigFile,
  saveConfigFile,
  setConfigKey,
  unsetConfigKey,
  configFilePath,
  configTemplate,
  redactConfig,
  DEFAULT_CONFIG,
} from '../../src/domain/config-file';

const xdgDir = mkdtempSync(join(tmpdir(), 'cleak-cfgfile-'));
const prevXdg = process.env.XDG_CONFIG_HOME;
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = xdgDir;
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(xdgDir, { recursive: true, force: true });
});
afterEach(() => {
  rmSync(configFilePath(), { force: true });
  rmSync(join(xdgDir, 'leak-inspector'), { recursive: true, force: true });
});

describe('load/save round-trip', () => {
  test('returns defaults when absent; persists + reloads; chmod 600', () => {
    expect(loadConfigFile()).toEqual(DEFAULT_CONFIG);
    const path = saveConfigFile({ staticUrl: 'http://x:50061/mcp', endpoints: { openai: { apiKey: 'sk-x' } } });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const loaded = loadConfigFile();
    expect(loaded.staticUrl).toBe('http://x:50061/mcp');
    expect(loaded.endpoints?.openai?.apiKey).toBe('sk-x');
  });
});

describe('lenient parse — one bad key never discards the rest', () => {
  test('keeps valid keys, drops invalid ones', () => {
    const p = configFilePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ staticUrl: 'http://ok/mcp', provider: 'not-a-provider', bogusKey: 1 }), 'utf-8');
    const loaded = loadConfigFile();
    expect(loaded.staticUrl).toBe('http://ok/mcp');
    expect(loaded.provider).toBeUndefined(); // invalid enum dropped
    expect((loaded as Record<string, unknown>).bogusKey).toBeUndefined();
  });
});

describe('setConfigKey — dot-path set with coercion + validation', () => {
  test('top-level string', () => {
    setConfigKey('staticUrl', 'http://a:50061/mcp');
    expect(loadConfigFile().staticUrl).toBe('http://a:50061/mcp');
  });
  test('nested number is coerced from string', () => {
    setConfigKey('consensus.n', '3');
    expect(loadConfigFile().consensus?.n).toBe(3);
  });
  test('boolean spellings coerce', () => {
    setConfigKey('autoShowReport', 'true');
    expect(loadConfigFile().autoShowReport).toBe(true);
  });
  test('per-provider endpoint path', () => {
    setConfigKey('endpoints.openai.apiKey', 'sk-y');
    expect(loadConfigFile().endpoints?.openai?.apiKey).toBe('sk-y');
  });
  test('preserves other keys across successive sets', () => {
    setConfigKey('staticUrl', 'http://a/mcp');
    setConfigKey('consensus.n', '5');
    const c = loadConfigFile();
    expect(c.staticUrl).toBe('http://a/mcp');
    expect(c.consensus?.n).toBe(5);
  });
  test('unknown key throws', () => {
    expect(() => setConfigKey('nope.x', '1')).toThrow(/unknown config key/);
  });
  test('invalid enum value throws', () => {
    expect(() => setConfigKey('consensus.rule', 'bogus')).toThrow(/invalid value/);
  });
});

describe('unsetConfigKey', () => {
  test('removes a key', () => {
    setConfigKey('staticUrl', 'http://a/mcp');
    unsetConfigKey('staticUrl');
    expect(loadConfigFile().staticUrl).toBeUndefined();
  });
});

describe('legacy migration (leak-inspector/prefs.json → cleak/config.json)', () => {
  test('maps defaultProvider → provider and carries endpoints', () => {
    const legacy = join(xdgDir, 'leak-inspector', 'prefs.json');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({ defaultProvider: 'openai', defaultMode: 'no_llm', endpoints: { openai: { model: 'm' } } }),
      'utf-8',
    );
    const loaded = loadConfigFile(); // no new file → reads legacy
    expect(loaded.provider).toBe('openai');
    expect(loaded.defaultMode).toBe('no_llm');
    expect(loaded.endpoints?.openai?.model).toBe('m');
  });
});

describe('template + redaction', () => {
  test('configTemplate is fully keyed', () => {
    const t = configTemplate();
    expect(t.staticUrl).toBeDefined();
    expect(t.dynamicUrl).toBeDefined();
    expect(t.consensus?.rule).toBe('weighted');
    expect(t.llm?.maxTokens).toBe(4096);
  });
  test('redactConfig masks endpoint apiKeys', () => {
    const r = redactConfig({ endpoints: { openai: { apiKey: 'sk-secret', model: 'm' } } });
    expect(r.endpoints?.openai?.apiKey).toBe('••••••');
    expect(r.endpoints?.openai?.model).toBe('m');
  });
});

describe('configFilePath', () => {
  test('honours XDG_CONFIG_HOME', () => {
    expect(configFilePath()).toBe(join(xdgDir, 'cleak', 'config.json'));
  });
  test('falls back to ~/.config when XDG unset', () => {
    const prev = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    expect(configFilePath()).toBe(join(homedir(), '.config', 'cleak', 'config.json'));
    process.env.XDG_CONFIG_HOME = prev;
  });
});
