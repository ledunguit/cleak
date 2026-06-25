/**
 * Minimal .env loader. The LLM key and gateway settings live in the repo-root
 * `.env` (or the TUI app's own `.env`); loading it here lets the TUI "just work"
 * without a separate config. The repo root is located independently of the
 * current working directory (so `bun run tui` from the app dir still finds the
 * key). Already-set process.env values always win (CLI/shell overrides take
 * precedence); the first file to define a key wins over later files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Locate the monorepo root from a starting dir by walking up to a marker. */
function findMarkerRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'turbo.json')) && existsSync(join(dir, 'apps'))) return dir;
    if (existsSync(join(dir, 'apps', 'leak-inspector-tui', 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Candidate repo roots: this module's location (deterministic) + the cwd walk. */
function repoRoots(cwd: string): string[] {
  const roots = new Set<string>();
  // This file is at <root>/apps/leak-inspector-tui/src/domain/env.ts → up 4 = root.
  const moduleDir = (import.meta as unknown as { dir?: string }).dir;
  if (moduleDir) {
    const fromModule = findMarkerRoot(moduleDir) ?? resolve(moduleDir, '../../../..');
    roots.add(fromModule);
  }
  const fromCwd = findMarkerRoot(cwd);
  if (fromCwd) roots.add(fromCwd);
  roots.add(cwd); // last resort
  return [...roots];
}

/**
 * The monorepo root (where docker-compose.yml mounts ./demo and ./targets into
 * the analyzer containers). Used as the default host-root for host→/workspace
 * path mapping when dynamic analysis runs against the Docker analyzers.
 */
export function monorepoRoot(cwd = process.cwd()): string | undefined {
  for (const root of repoRoots(cwd)) {
    if (existsSync(join(root, 'docker-compose.yml')) || (existsSync(join(root, 'turbo.json')) && existsSync(join(root, 'apps'))))
      return root;
  }
  return undefined;
}

/** Default search order: <root>/.env, then <root>/apps/leak-inspector-tui/.env (LLM key). */
export function defaultEnvFiles(cwd = process.cwd()): string[] {
  const files: string[] = [];
  for (const root of repoRoots(cwd)) {
    files.push(join(root, '.env'), join(root, 'apps', 'leak-inspector-tui', '.env'));
  }
  return files;
}

export function loadEnvFiles(paths: string[] = defaultEnvFiles()): void {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}
