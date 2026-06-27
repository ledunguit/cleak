/**
 * Persisted user config for the cleak CLI — the full RunConfig surface (so a
 * globally-installed `@cleak/cli` can be configured WITHOUT env vars), stored as
 * JSON under the XDG config dir (`$XDG_CONFIG_HOME|~/.config` + `cleak/config.json`).
 *
 * Read at the single `loadConfig()` chokepoint (src/config.ts), so every surface
 * (tui / scan / eval / tools) honours it. Precedence is CLI flag > env > THIS file
 * > built-in default — env always wins over the file (see config.ts `pick*`).
 *
 * The file may hold an apiKey, so it is written chmod 600. Validated with Zod:
 * invalid keys are dropped (with a one-line stderr warning), never fatal.
 */

import { z } from 'zod';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';

const PROVIDERS = ['local', 'openai', 'anthropic', 'openai-compat'] as const;

/** Accept JSON booleans and the common string spellings (for `config set x true`). */
const zBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'yes');
/** Accept numbers and numeric strings (for `config set maxTurns 30`). */
const zNum = z.coerce.number();

const endpointSchema = z
  .object({ baseUrl: z.string(), model: z.string(), apiKey: z.string() })
  .partial();

export const CleakConfigSchema = z
  .object({
    // TUI session defaults (not part of RunConfig — consumed by launchTui).
    defaultMode: z.enum(['no_llm', 'llm_assisted']),
    defaultDynamic: z.enum(['off', 'selective', 'aggressive']),
    autoShowReport: zBool,
    // Provider + per-provider endpoint overrides.
    provider: z.enum(PROVIDERS),
    endpoints: z
      .object({
        local: endpointSchema,
        openai: endpointSchema,
        anthropic: endpointSchema,
        'openai-compat': endpointSchema,
      })
      .partial(),
    // Analyzer MCP endpoints (the headline reason this file exists).
    staticUrl: z.string(),
    dynamicUrl: z.string(),
    // Host↔analyzer path mapping (Docker analyzers).
    hostRoot: z.string(),
    analyzerRoot: z.string(),
    // Outputs + agent budget.
    resultsDir: z.string(),
    maxTurns: zNum,
    // Provider-agnostic LLM tuning.
    llm: z
      .object({
        temperature: zNum,
        judgeTemperature: zNum,
        timeoutMs: zNum,
        idleTimeoutMs: zNum,
        connectTimeoutMs: zNum,
        retries: zNum,
        maxTokens: zNum,
        jsonMode: zBool,
      })
      .partial(),
    compaction: z.object({ thresholdTokens: zNum, keepRecentTurns: zNum }).partial(),
    workflow: z
      .object({ staticConcurrency: zNum, staticGroupSize: zNum, judgeConcurrency: zNum })
      .partial(),
    consensus: z
      .object({
        n: zNum,
        rule: z.enum(['majority', 'weighted', 'unanimous-to-flag']),
        temperature: zNum,
        concurrency: zNum,
      })
      .partial(),
  })
  .partial();

export type CleakConfig = z.infer<typeof CleakConfigSchema>;
export type EndpointOverride = z.infer<typeof endpointSchema>;

/** The TUI session defaults that aren't otherwise represented in env/RunConfig. */
export const DEFAULT_CONFIG: CleakConfig = {
  defaultMode: 'llm_assisted',
  defaultDynamic: 'off',
  autoShowReport: false,
};

function warn(msg: string): void {
  process.stderr.write(`⚠ ${msg}\n`);
}

function xdgConfigDir(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

/** The active config path: `<xdg>/cleak/config.json`. */
export function configFilePath(): string {
  return join(xdgConfigDir(), 'cleak', 'config.json');
}

/** The pre-rename prefs file (`<xdg>/leak-inspector/prefs.json`) for one-time migration. */
function legacyPrefsPath(): string {
  return join(xdgConfigDir(), 'leak-inspector', 'prefs.json');
}

/** Read the legacy prefs file and map its keys onto the new schema (or undefined). */
function readLegacy(): Record<string, unknown> | undefined {
  const path = legacyPrefsPath();
  if (!existsSync(path)) return undefined;
  try {
    const old = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const { defaultProvider, ...rest } = old;
    // `defaultProvider` was renamed to `provider`; everything else carries over.
    return { ...rest, ...(defaultProvider ? { provider: defaultProvider } : {}) };
  } catch {
    return undefined;
  }
}

/** The file object exactly as on disk (NO defaults merged), {} if absent/unreadable. */
function rawFileObject(): Record<string, unknown> {
  const path = configFilePath();
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      warn(`${path} is not valid JSON — ignored`);
      return {};
    }
  }
  return readLegacy() ?? {};
}

/** Validate top-level keys INDEPENDENTLY so one bad key doesn't discard the rest. */
function lenientParse(raw: Record<string, unknown>): CleakConfig {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const one = CleakConfigSchema.safeParse({ [k]: v });
    if (one.success && (one.data as Record<string, unknown>)[k] !== undefined) {
      out[k] = (one.data as Record<string, unknown>)[k];
    } else {
      warn(`ignoring invalid config key "${k}"`);
    }
  }
  return out as CleakConfig;
}

/** Read the config file merged over DEFAULT_CONFIG. Never throws (returns defaults). */
export function loadConfigFile(): CleakConfig {
  return { ...DEFAULT_CONFIG, ...lenientParse(rawFileObject()) };
}

/** Persist a config object (lenient-validated). Returns the path. chmod 600 (apiKey). */
export function saveConfigFile(cfg: Record<string, unknown>): string {
  const clean = lenientParse(cfg as Record<string, unknown>);
  const path = configFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(clean, null, 2) + '\n', 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort (e.g. unsupported FS) — content is still written */
  }
  return path;
}

function setDeep(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

function getDeep(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function deleteDeep(obj: Record<string, unknown>, path: string[]): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) return;
    cur = cur[k] as Record<string, unknown>;
  }
  delete cur[path[path.length - 1]];
}

/** Set one dot-path key (`staticUrl`, `consensus.n`, `endpoints.openai.apiKey`),
 * validating + coercing the value. Throws on unknown key / invalid value. */
export function setConfigKey(dotPath: string, rawValue: string): string {
  const path = dotPath.split('.');
  // Validate the single key in isolation so a pre-existing odd key can't block it.
  const probe: Record<string, unknown> = {};
  setDeep(probe, path, rawValue);
  const one = CleakConfigSchema.safeParse(probe);
  if (!one.success) {
    throw new Error(`invalid value for "${dotPath}": ${one.error.issues[0]?.message ?? 'rejected'}`);
  }
  const coerced = getDeep(one.data, path);
  if (coerced === undefined) throw new Error(`unknown config key "${dotPath}"`);
  const cur = rawFileObject();
  setDeep(cur, path, coerced);
  return saveConfigFile(cur);
}

/** Remove one dot-path key from the file. Returns the path written. */
export function unsetConfigKey(dotPath: string): string {
  const cur = rawFileObject();
  deleteDeep(cur, dotPath.split('.'));
  return saveConfigFile(cur);
}

/** A fully-keyed template (defaults + blank secrets) for `cleak config init`. */
export function configTemplate(): CleakConfig {
  return {
    defaultMode: 'llm_assisted',
    defaultDynamic: 'off',
    autoShowReport: false,
    provider: 'local',
    endpoints: {
      local: { baseUrl: 'http://localhost:20128/v1', model: 'mimo/mimo-v2.5-pro', apiKey: '' },
    },
    staticUrl: 'http://localhost:50061/mcp',
    dynamicUrl: 'http://localhost:50062/mcp',
    resultsDir: 'results',
    maxTurns: 15,
    llm: {
      temperature: 0,
      judgeTemperature: 0,
      timeoutMs: 75000,
      idleTimeoutMs: 75000,
      connectTimeoutMs: 30000,
      retries: 2,
      maxTokens: 4096,
      jsonMode: true,
    },
    compaction: { thresholdTokens: 100000, keepRecentTurns: 3 },
    workflow: { staticConcurrency: 3, staticGroupSize: 4, judgeConcurrency: 3 },
    consensus: { n: 1, rule: 'weighted', temperature: 0.7, concurrency: 3 },
  };
}

/** Deep-clone with the apiKey fields masked, for `config get` / display. */
export function redactConfig<T>(cfg: T): T {
  const clone = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  const eps = clone.endpoints as Record<string, { apiKey?: string }> | undefined;
  if (eps) for (const ep of Object.values(eps)) if (ep?.apiKey) ep.apiKey = '••••••';
  return clone as T;
}
