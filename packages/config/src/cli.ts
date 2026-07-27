/**
 * CLI helper functions for reading and writing the persisted config file via
 * dot-path key expressions (`cleak config set consensus.n 3`).
 */

import { CleakConfigSchema } from './schema.js';
import { rawFileObject, saveConfigFile } from './persist.js';

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

/* configTemplate is defined in persist.ts (needed by saveConfigFile's fillDefaults).
 * It is re-exported here for the CLI surface and appears in the barrel from this file. */
export { configTemplate } from './persist.js';
