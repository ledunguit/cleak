/**
 * Workspace root detection. Locates the monorepo root from a starting dir by
 * walking up to a marker (turbo.json + apps/, or docker-compose.yml).
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const moduleDir = ((): string | undefined => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return undefined;
    }
  })();
  if (moduleDir) {
    const fromModule = findMarkerRoot(moduleDir) ?? resolve(moduleDir, '../../../..');
    roots.add(fromModule);
  }
  const fromCwd = findMarkerRoot(cwd);
  if (fromCwd) roots.add(fromCwd);
  roots.add(cwd);
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
