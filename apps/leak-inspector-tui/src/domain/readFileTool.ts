/**
 * The one domain tool the staged investigation actually exposes to its sub-agents:
 * a sandboxed `read_file` so a static/dynamic worker can read source it reasons
 * about. (Verdicts come from the Stage-D heuristic + consensus judge, and dynamic
 * evidence from deterministic capture — so the old free-form domain tools
 * `record_verdict` / `record_evidence` / `list_candidates` / `finalize` are gone.)
 */

import { resolve, isAbsolute } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { z } from 'zod';
import { buildTool, type Tool } from '@cleak/agent-core';

const MAX_FILE_CHARS = 16_000;

/** A sandboxed source reader rooted at `repoPath` (relative or in-repo absolute paths). */
export function buildReadFileTool(repoPath: string): Tool {
  const root = resolve(repoPath);
  return buildTool({
    name: 'read_file',
    description:
      'Read a source file from the repository (path relative to the repo root, or an absolute path inside it). Returns up to 16000 characters.',
    inputSchema: z.object({ path: z.string() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    renderTitle: (input) => `read_file ${input?.path ?? ''}`,
    call: async (input: { path: string }) => {
      const target = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path);
      if (!target.startsWith(root)) {
        return { error: 'Path is outside the repository root.' };
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        return { error: `File not found: ${input.path}` };
      }
      const content = readFileSync(target, 'utf-8');
      return {
        path: input.path,
        truncated: content.length > MAX_FILE_CHARS,
        content: content.slice(0, MAX_FILE_CHARS),
      };
    },
  });
}
