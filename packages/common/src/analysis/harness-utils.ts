/**
 * Shared utility functions used across evaluation harnesses and corpus tooling.
 *
 * Extracted from duplicate inline implementations in `evalHarness.ts`,
 * `runBaselineEval.ts`, `corpusLock.ts`, and `validate-corpus.ts` — the definitive
 * versions live here so every caller counts LOC and lists source files identically.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DEFAULT_SRC_EXT = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);

/**
 * Directories that are never part of a case's checked-in source identity, even
 * when they land inside the case dir — build outputs from a prior dynamic run
 * (`buildTarget` builds in-place, e.g. `cmake -S . -B build`) as well as VCS/
 * dependency dirs. Without this exclusion, running the dynamic worker once
 * against a case would leak generated headers/objects into both the corpus
 * content-hash (spurious "corpus drifted from lock" gate failures on rerun)
 * and the FP/KLOC denominator (silently inflating it with non-source LOC).
 */
const SKIP_DIRS = new Set(['build', '_build', 'cmake-build-debug', 'node_modules', '.git', 'dist', 'out', '.cache']);

/**
 * Non-blank lines of a case's IMPLEMENTATION files — the FP/KLOC denominator.
 * Counts only `.c/.cc/.cpp/.cxx` (NOT headers): false positives are flagged at
 * allocation sites in implementation code, so including header declaration lines
 * would dilute the rate without adding flaggable sites.
 *
 * Uses a simple recursive directory walk (SKIP_DIRS-filtered, no file limit) —
 * this is the intersection of the old `evalHarness.ts` version (recursive via
 * walkCFiles) and `runBaselineEval.ts` (flat readdir). Works correctly for both
 * flat Juliet cases and real multi-directory projects.
 *
 * @param repoDir - Absolute path to the case/repo directory
 * @returns Total non-blank lines in .c/.cc/.cpp/.cxx implementation files
 */
export function countSourceLoc(repoDir: string): number {
  let loc = 0;
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(fullPath);
      } else if (/\.(c|cc|cpp|cxx)$/.test(entry)) {
        try {
          const src = readFileSync(fullPath, 'utf-8');
          for (const line of src.split('\n')) {
            if (line.trim() !== '') loc++;
          }
        } catch {
          // unreadable file — skip its lines
        }
      }
    }
  };
  visit(repoDir);
  return loc;
}

/**
 * Recursively list C/C++ source files under a directory, filtered by extension.
 * Silently skips unreadable directories/files.
 *
 * @param dir - Root directory to scan
 * @param exts - Set of extensions to include (default: includes both implementation
 *               `.c/.cc/.cpp/.cxx` and header `.h/.hh/.hpp/.hxx` files)
 * @returns Sorted array of matching absolute file paths
 */
export function listSourceFiles(dir: string, exts?: Set<string>): string[] {
  const extsSet = exts ?? DEFAULT_SRC_EXT;
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.startsWith('.') || SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out = out.concat(listSourceFiles(full, extsSet));
    } else if (extsSet.has(extname(e).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}
