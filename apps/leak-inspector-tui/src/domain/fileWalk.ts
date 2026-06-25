/**
 * Host-side file enumeration. The orchestrator (cleak) owns the workspace on
 * the host; the MCP analyzers are stateless analysis services that receive file
 * CONTENT, never a shared filesystem path. So discovery walks the repo here and
 * reads each file locally — this works identically whether the analyzers run in
 * a local container or on a remote host.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  '.cache',
  '.svn',
  '__pycache__',
  'cmake-build-debug',
  'out',
  'vendor',
  'third_party',
]);

const C_EXTS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx', '.hh']);

/** Recursively collect C/C++ source files under `root` (absolute host paths). */
export function walkCFiles(root: string, limit = 2000): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) visit(full);
      } else if (st.isFile()) {
        const dot = entry.lastIndexOf('.');
        if (dot >= 0 && C_EXTS.has(entry.slice(dot).toLowerCase())) out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

export function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
