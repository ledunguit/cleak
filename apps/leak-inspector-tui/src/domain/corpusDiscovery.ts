/**
 * Enumerate available eval corpora so the TUI's eval-setup wizard can offer a
 * picker instead of requiring the operator to already know the exact path.
 * Reuses the EXISTING validation machinery (`corpusLock.ts`'s `checkCorpusGate`)
 * unchanged — this module only surfaces what's already computed there, before
 * the user commits to a run (today a bad corpus only fails mid-`runEval`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { checkCorpusGate, type CorpusGateResult } from './corpusLock';

export interface CorpusInfo {
  /** Absolute path to the corpus directory. */
  dir: string;
  /** Directory basename — the label shown in the picker. */
  name: string;
  /** Number of cases in `corpus_manifest.json` (0 if unreadable). */
  caseCount: number;
  gate: CorpusGateResult;
}

/** Known dataset roots documented in `docs/DATASETS.md` — all git-ignored except
 * committed sources, so presence varies by checkout; missing ones are just
 * skipped, not an error. */
const DEFAULT_CORPUS_DIRS = ['demo/juliet_cwe401', 'demo/lamed'];

function caseCountOf(corpusDir: string): number {
  try {
    const manifest = JSON.parse(readFileSync(join(corpusDir, 'corpus_manifest.json'), 'utf-8'));
    return Array.isArray(manifest.cases) ? manifest.cases.length : 0;
  } catch {
    return 0;
  }
}

function corpusInfoFor(dir: string): CorpusInfo | null {
  const abs = resolve(dir);
  if (!existsSync(join(abs, 'corpus_manifest.json'))) return null;
  return { dir: abs, name: basename(abs), caseCount: caseCountOf(abs), gate: checkCorpusGate(abs) };
}

/**
 * Discover corpora under the given roots. With NO `roots` argument (the normal
 * picker-population call), this is the 4 documented datasets under `demo/`
 * PLUS a sibling-scan of `demo/` itself, so a locally-added corpus (e.g. a
 * project-specific one) shows up without a code change. With an EXPLICIT
 * `roots` array, only those exact directories are checked — no sibling-scan —
 * so a caller asking for one specific corpus never gets unrelated ones back
 * just because they happen to share a parent directory (this matters for
 * tests, and for any future narrower caller). Deduplicated by resolved path,
 * sorted by name for a stable picker order.
 */
export function discoverCorpora(roots?: string[], cwd = process.cwd()): CorpusInfo[] {
  const explicit = roots !== undefined;
  const rootList = roots ?? DEFAULT_CORPUS_DIRS;

  const seen = new Map<string, CorpusInfo>();
  const add = (dir: string) => {
    const info = corpusInfoFor(dir);
    if (info && !seen.has(info.dir)) seen.set(info.dir, info);
  };

  for (const root of rootList) {
    add(join(cwd, root));
  }

  if (!explicit) {
    // Sibling-scan ONLY on the default (no-args) path — pick up anything else
    // dropped into each default root's parent (e.g. `demo/`) without requiring
    // a code change per new corpus.
    const parents = new Set(rootList.map((r) => join(cwd, r, '..')));
    for (const parent of parents) {
      let entries: string[];
      try {
        entries = readdirSync(parent);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(parent, entry);
        try {
          if (!statSync(full).isDirectory()) continue;
        } catch {
          continue;
        }
        add(full);
      }
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
