/**
 * The one domain tool the staged investigation actually exposes to its sub-agents:
 * a sandboxed `read_file` so a static/dynamic worker can read source it reasons
 * about. (Verdicts come from the Stage-D heuristic + consensus judge, and dynamic
 * evidence from deterministic capture — so the old free-form domain tools
 * `record_verdict` / `record_evidence` / `list_candidates` / `finalize` are gone.)
 */

import { resolve, isAbsolute, join, dirname, basename, sep } from 'node:path';
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { buildTool, type Tool } from '@cleak/agent-core';
import type { FileContentCache } from './fileContentCache';

const MAX_FILE_CHARS = 16_000;

type ReadFileResult =
  | { error: string }
  | { path: string; truncated: boolean; content: string };

/** Canonicalize `p` — realpath the deepest existing ancestor so a symlink
 * inside the repo cannot smuggle reads to a path outside it. */
function canonicalize(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  const real = realpathSync(cur);
  return tail.length ? join(real, ...tail) : real;
}

/** A sandboxed source reader rooted at `repoPath` (relative or in-repo absolute paths).
 * When `fileCache` is provided (per-scan memoization), reads go through it so the same
 * file is read off disk once per scan instead of once per read_file call. */
export function buildReadFileTool(repoPath: string, fileCache?: FileContentCache): Tool {
  const root = resolve(repoPath);
  const rootReal = canonicalize(root);
  return buildTool({
    name: 'read_file',
    description:
      'Read a source file from the repository (path relative to the repo root, or an absolute path inside it). Returns up to 16000 characters.',
    inputSchema: z.object({ path: z.string() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    renderTitle: (input) => `read_file ${input?.path ?? ''}`,
    call: async (input: { path: string }) => {
      // Canonicalize + separator-aware containment: rejects `..` escapes,
      // sibling prefixes (/repo2), and symlinks that resolve outside the repo.
      const target = canonicalize(isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path));
      if (target !== rootReal && !target.startsWith(rootReal + sep)) {
        return { error: 'Path is outside the repository root.' };
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        return { error: `File not found: ${input.path}` };
      }
      const content = fileCache ? (fileCache.read(target) ?? '') : readFileSync(target, 'utf-8');
      return {
        path: input.path,
        truncated: content.length > MAX_FILE_CHARS,
        content: content.slice(0, MAX_FILE_CHARS),
      };
    },
  });
}
