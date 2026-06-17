/**
 * Persisted user preferences for the TUI — the defaults a user sets once on the
 * /config screen and expects to survive across sessions. Stored as JSON under the
 * XDG config dir (or ~/.config). Distinct from RunConfig (env-driven runtime
 * config): these are interactive, user-owned choices, not deployment settings.
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import type { Provider } from '../../config';

/** Per-provider endpoint override. Any unset field falls back to env/default at
 * `resolveProvider` time — only non-empty values override. */
export interface EndpointOverride {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface UserPreferences {
  defaultMode: 'no_llm' | 'llm_assisted';
  defaultDynamic: 'off' | 'selective' | 'aggressive';
  /** Auto-open the report findings picker when a scan finishes. */
  autoShowReport: boolean;
  /** Optional default provider override (env still wins if this is unset). */
  defaultProvider?: Provider;
  /** Per-provider base URL / model / API key overrides (so switching provider
   * remembers each one). The API key may live here — the file is chmod 600. */
  endpoints?: Partial<Record<Provider, EndpointOverride>>;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  defaultMode: 'llm_assisted',
  defaultDynamic: 'off',
  autoShowReport: false,
};

function prefsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'leak-inspector', 'prefs.json');
}

/** Read prefs from disk, merged over defaults; never throws (returns defaults). */
export function loadPreferences(): UserPreferences {
  try {
    const path = prefsPath();
    if (!existsSync(path)) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return { ...DEFAULT_PREFERENCES, ...parsed };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Persist prefs to disk (creating the config dir). Returns the path written.
 * The file is chmod 600 — it may hold a custom-endpoint API key. */
export function savePreferences(prefs: UserPreferences): string {
  const path = prefsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs, null, 2) + '\n', 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort (e.g. unsupported FS) — content is still written */
  }
  return path;
}
