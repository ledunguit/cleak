/**
 * WORKSPACE_ROOT enforcement for the dynamic-analyzer (see docs/SECURITY.md).
 *
 * The analyzer builds and executes code from whatever repository is under scan,
 * so every path that reaches a tool which compiles or runs something must be
 * contained inside a single configured sandbox root. Before this file existed,
 * WORKSPACE_ROOT was documented in SECURITY.md / CLAUDE.md but NOT enforced
 * anywhere — a caller could pass an arbitrary absolute path (e.g. a binary to
 * run, or a project to build) and the analyzer would happily operate on it.
 *
 * Enforcement (`assertInsideWorkspace` / `assertExecutablePath`):
 *  - WORKSPACE_ROOT env var selects the sandbox. Default: `/workspace` when it
 *    exists (docker-compose bind-mounts scanned repos under /workspace), else
 *    process.cwd() (host dev). A loud warning is logged when the default is
 *    used so operators can pin WORKSPACE_ROOT explicitly.
 *  - The input is normalized with `path.resolve` (collapses `..`/`.` segments)
 *    and must land inside the canonical root. Containment is a separator-aware
 *    prefix comparison (`root + sep`), so a sibling path like `/root2/x` does
 *    NOT pass the `/root` check.
 *  - Symlinks: the deepest EXISTING ancestor of the input is `realpath`'d; if
 *    it resolves outside the canonical root, the path is rejected (symlink-out).
 *    Missing tails are allowed through (a tool may still ENOENT later) as long
 *    as every existing ancestor is inside the root — realpath cannot resolve a
 *    not-yet-existing tail, so only the existing prefix is canonicalized.
 *  - `assertExecutablePath` additionally permits the analyzer's OWN artifact
 *    directory (RUNS_DIR): buildHarness writes binaries there and the TUI
 *    legitimately runs them via lsanRun/asanRun/runBinary/libfuzzerRun.
 *    Artifact paths are server-generated (sanitized runId only), so this does
 *    not open a caller-controlled escape; a caller-supplied path must still
 *    be inside WORKSPACE_ROOT or inside RUNS_DIR.
 */

import { Logger } from '@nestjs/common';
import { existsSync, realpathSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';

const logger = new Logger('PathGuard');

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathGuardError';
  }
}

let cachedRoot: string | null = null;
let warnedAboutDefault = false;

/** Canonical WORKSPACE_ROOT (resolved once per process). */
export function getWorkspaceRoot(): string {
  if (cachedRoot) return cachedRoot;
  const explicit = (process.env.WORKSPACE_ROOT || '').trim();
  const root = explicit
    ? resolve(explicit)
    : existsSync('/workspace')
      ? '/workspace' // docker-compose mounts scanned repos under /workspace
      : process.cwd(); // host dev
  if (!explicit && !warnedAboutDefault) {
    warnedAboutDefault = true;
    logger.warn(
      `WORKSPACE_ROOT not set — defaulting sandbox root to "${root}". ` +
        'Set WORKSPACE_ROOT explicitly to pin the sandbox boundary.',
    );
  }
  cachedRoot = root;
  return root;
}

/** Canonical RUNS_DIR (artifact directory — trusted for executables we built). */
export function getRunsDir(): string {
  return resolve(process.env.RUNS_DIR || './runs');
}

/**
 * Realpath the deepest existing ancestor of `abs`; return it together with the
 * not-yet-existing tail (joined with sep). Throws PathGuardError if even the
 * deepest existing prefix itself fails to canonicalize.
 */
function realpathDeepestExisting(abs: string): { real: string; tail: string } {
  let cur = abs;
  const tailParts: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break; // hit the filesystem root without finding it
    tailParts.unshift(basename(cur));
    cur = parent;
  }
  const real = realpathSync(cur); // canonicalizes symlinks in every existing prefix
  return { real, tail: tailParts.join(sep) };
}

/**
 * Assert that `p` resolves (canonically, symlinks followed) inside `root`.
 * Returns the canonical form of `p` on success; throws PathGuardError otherwise.
 */
function assertInsideRoot(p: string, root: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new PathGuardError('empty path');
  const rootReal = realpathSync(root); // throws -> WORKSPACE_ROOT misconfiguration
  const abs = resolve(p);

  // Canonical containment only: realpath the deepest EXISTING ancestor of the
  // resolved path and compare it against the realpath'd root. This is strictly
  // stronger than a textual prefix check — resolve() already collapsed `..` and
  // sibling prefixes fail the separator-aware comparison — and, crucially, the
  // realpath makes the comparison symlink-consistent even when the ROOT ITSELF
  // is reached through a symlink (macOS /var -> /private/var, /tmp -> /private/tmp)
  // or a container bind-mount. A symlink inside the root that points outside is
  // rejected because its realpath leaves the root. Missing tails are appended
  // after the check and cannot escape: resolve() removed any `..`, and a
  // non-existent component cannot be a symlink.
  const { real, tail } = realpathDeepestExisting(abs);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new PathGuardError(`path escapes WORKSPACE_ROOT (${rootReal}): ${p}`);
  }
  return tail.length ? join(real, ...tail.split(sep)) : real;
}

/**
 * Enforce WORKSPACE_ROOT containment for a project/source path supplied by the
 * caller (projectPath, targetFile, closureFiles). Returns the canonical path.
 */
export function assertInsideWorkspace(p: string): string {
  return assertInsideRoot(p, getWorkspaceRoot());
}

/**
 * Enforce containment for a path that will be EXECUTED (binaryPath): must be
 * inside WORKSPACE_ROOT or inside the analyzer's own RUNS_DIR (where
 * buildHarness places binaries we compiled ourselves). Returns the canonical
 * path, or throws PathGuardError with the rejection reason.
 */
export function assertExecutablePath(p: string): string {
  for (const root of [getWorkspaceRoot(), getRunsDir()]) {
    try {
      return assertInsideRoot(p, root);
    } catch {
      /* try the next allowed root */
    }
  }
  throw new PathGuardError(
    `binary path is neither inside WORKSPACE_ROOT (${getWorkspaceRoot()}) nor inside RUNS_DIR (${getRunsDir()}): ${p}`,
  );
}

/** Separator-aware "is `child` inside `parent` (both canonical)" check. */
export function isPathInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
