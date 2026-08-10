/**
 * Persisted user config for the cleak CLI — the full RunConfig surface (so a
 * globally-installed `@cleak/cli` can be configured WITHOUT env vars), stored as
 * JSON under the XDG config dir (`$XDG_CONFIG_HOME|~/.config` + `cleak/config.json`).
 *
 * Read at the single `loadConfig()` chokepoint (src/loader.ts), so every surface
 * (tui / scan / eval / tools) honours it. Precedence is CLI flag > THIS file >
 * built-in default.
 *
 * The file may hold an apiKey, so it is written chmod 600. Validated with Zod:
 * invalid keys are dropped (with a one-line stderr warning), never fatal.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { CleakConfigSchema, type CleakConfig, DEFAULT_CONFIG } from './schema.js';

const CONFIG_BACKUP_SUFFIX = '.bak';

function warn(msg: string): void {
  process.stderr.write(`\u26a0 ${msg}\n`);
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

/** The file object exactly as on disk (NO defaults merged), {} if absent/unreadable.
 * On parse error, tries `<path>.bak` before giving up — prevents data loss from a
 * transiently corrupted file (partial write, concurrent access, etc.). */
export function rawFileObject(): Record<string, unknown> {
  const path = configFilePath();
  if (!existsSync(path)) return readLegacy() ?? {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    // Zustand persist middleware wraps config in { state: {...}, version: N }.
    // Unwrap it so the old config system reads flat keys directly.
    if (data && typeof data === 'object' && 'state' in data) {
      return data.state as Record<string, unknown>;
    }
    return data;
  } catch {
    warn(`${path} is not valid JSON`);
    // Try the backup before giving up
    const bak = path + CONFIG_BACKUP_SUFFIX;
    if (existsSync(bak)) {
      try {
        const raw = readFileSync(bak, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (data && typeof data === 'object' && 'state' in data) {
          return data.state as Record<string, unknown>;
        }
        return data;
      } catch {
        warn(`${bak} also unreadable — returning empty config`);
      }
    }
    return {};
  }
}

/** Validate top-level keys INDEPENDENTLY so one bad key doesn't discard the rest.
 * Keys that exist in the schema but have an invalid value are dropped (otherwise
 * downstream code would crash on bad data). Keys NOT in the schema are preserved
 * as-is so a downgrade or schema rollback does not silently wipe them. */
export function lenientParse(raw: Record<string, unknown>): CleakConfig {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const one = CleakConfigSchema.safeParse({ [k]: v });
    if (one.success && (one.data as Record<string, unknown>)[k] !== undefined) {
      out[k] = (one.data as Record<string, unknown>)[k];
    } else if (one.success && (one.data as Record<string, unknown>)[k] === undefined) {
      // Key successfully validated but coerced to undefined — treat as present
      // (e.g. `fullscreen: false` in the schema passes but false was coerced).
      out[k] = v;
    } else if (k in CleakConfigSchema.shape) {
      // Key is known to the schema but value failed validation — drop to avoid
      // crashing downstream with junk data (e.g. provider='not-a-provider').
      warn(`config key "${k}" has an invalid value — dropped`);
    } else {
      // Key is NOT in the schema at all — preserve raw value for forward compat
      // (e.g. a future version's settings survive a downgrade).
      warn(`config key "${k}" is not recognized — preserving raw value`);
      out[k] = v;
    }
  }
  return out as CleakConfig;
}

/** Read the config file merged over DEFAULT_CONFIG. Never throws (returns defaults). */
export function loadConfigFile(): CleakConfig {
  return { ...DEFAULT_CONFIG, ...lenientParse(rawFileObject()) };
}

/** Persist a config object (lenient-validated). Returns the path. chmod 600 (apiKey).
 * Creates a `.bak` copy of the existing file before overwriting, so a crash during
 * write cannot wipe the config entirely.
 * When `fillDefaults` is true, the config is merged with `configTemplate()` + the
 * existing file before writing — guaranteeing ALL keys are present even when the
 * caller passes a partial object (defense against stale in-memory drafts). */
export function saveConfigFile(cfg: Record<string, unknown>, opts?: { fillDefaults?: boolean }): string {
  // When fillDefaults is set, overlay cfg on top of the full template + existing
  // file data so a partial caller (e.g. ConfigScreen save) never drops keys.
  const target = opts?.fillDefaults
    ? { ...configTemplate(), ...(loadConfigFile() as Record<string, unknown>), ...cfg }
    : cfg;
  const clean = lenientParse(target);
  const path = configFilePath();
  // Backup the existing file before overwriting
  if (existsSync(path)) {
    try { copyFileSync(path, path + CONFIG_BACKUP_SUFFIX); } catch { /* best-effort */ }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(clean, null, 2) + '\n', 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort (e.g. unsupported FS) — content is still written */
  }
  return path;
}

/** Deep-clone with the apiKey fields masked, for `config get` / display. */
export function redactConfig<T>(cfg: T): T {
  const clone = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  const eps = clone.endpoints as Record<string, { apiKey?: string }> | undefined;
  if (eps) for (const ep of Object.values(eps)) if (ep?.apiKey) ep.apiKey = '\u2022\u2022\u2022\u2022\u2022\u2022';
  return clone as T;
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
    workflow: {
      staticConcurrency: 3,
      staticGroupSize: 4,
      judgeConcurrency: 3,
      discoveryConcurrency: 4,
      targetedHarness: { enabled: false, maxHarnessesPerScan: 5, concurrency: 2, timeoutMs: 60000, fuzzBudgetMs: 15000, maxClosureFiles: 8, verifyConfirmedLeaks: false },
      allocatorVerification: { enabled: false, maxVerifications: 20, concurrency: 2, timeoutMs: 30000 },
      ownershipVerification: { enabled: false, maxVerifications: 15, concurrency: 2, timeoutMs: 30000 },
    },
    consensus: { n: 1, rule: 'weighted', temperature: 0.7, concurrency: 3 },
    fullscreen: false,
    inContainer: false,
    staticEnrich: false,
    sidebarPosition: 'right',
    thresholds: { borderlineLow: 0.35, borderlineHigh: 0.7 },
    baselines: { clangBin: 'clang', inferBin: 'infer' },
    // Empty by design — fill in via `cleak config set pricing.<modelId>.inputPerMillion <price>`.
    pricing: {},
  };
}
