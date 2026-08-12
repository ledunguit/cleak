/**
 * Shared tool wrappers used by the investigation orchestrators. The workspace
 * lives on the host, so static (content-based) tools get the file content injected
 * host-side, and dynamic tools get their filesystem paths translated host→analyzer.
 */

import { isAbsolute, resolve } from 'node:path';
import type { Tool } from '@cleak/agent-core';
import { readFileSafe } from '../domain/fileWalk';
import type { FileContentCache } from '../domain/fileContentCache';
import type { ToolResultCache } from '../domain/toolResultCache';

/**
 * Inject the host file's content into a content-based MCP tool call. The agent
 * passes a `filePath` (host path, absolute or repo-relative); we read it on the
 * host and add `content`, so the stateless analyzer never needs filesystem access.
 * When `fileCache` is provided (per-scan memoization), the read shares the scan's
 * single-read cache instead of a fresh `readFileSync` per tool call.
 */
export function withHostContent(tool: Tool, repoPath: string, fileCache?: FileContentCache): Tool {
  return {
    ...tool,
    call: (input: any, ctx) => {
      const next = input && typeof input === 'object' ? { ...input } : input;
      if (next && typeof next === 'object' && typeof next.filePath === 'string') {
        const abs = isAbsolute(next.filePath) ? next.filePath : resolve(repoPath, next.filePath);
        if (!next.content) {
          const content = fileCache ? fileCache.read(abs) : readFileSafe(abs);
          if (content !== null) next.content = content;
        }
        next.filePath = abs;
      }
      return tool.call(next, ctx);
    },
  };
}

/**
 * Memoize identical evidence tool calls (perf P0-2). A repeat call with the SAME
 * tool + same (content-excluded) args returns the cached successful result instead
 * of re-invoking the MCP analyzer — saving both the round-trip and the second copy
 * of the result in the agent's context. Only successful results are cached (an
 * error is a real signal and must not be short-circuited). The key drops `content`
 * (implied by filePath) so the deterministic enrichment stage and the sub-agents
 * agree on the same key for the same analysis request.
 */
export function withToolResultDedup(tool: Tool, cache: ToolResultCache): Tool {
  return {
    ...tool,
    call: async (input: any, ctx) => {
      const cached = cache.get(tool.name, input);
      if (cached !== undefined) return cached;
      const out = await tool.call(input, ctx);
      cache.set(tool.name, input, out);
      return out;
    },
  };
}

/**
 * Translate filesystem path arguments (host → analyzer) for dynamic tools, which
 * build/compile/run code on the analyzer's filesystem. Identity when no mapping
 * is configured (the analyzer shares the host filesystem).
 */
export function withHostPathMapping(
  tool: Tool,
  resolver: { hasMapping(): boolean; toAnalyzerPath(p: string): string },
): Tool {
  if (!resolver.hasMapping()) return tool;
  const PATH_KEYS = ['projectPath', 'binaryPath', 'cwd', 'workdir', 'targetFile'];
  // `buildHarness`'s closureFiles is a list of host paths the LLM worker supplies
  // alongside targetFile — every element needs the same host→analyzer translation.
  const PATH_ARRAY_KEYS = ['closureFiles'];
  return {
    ...tool,
    call: (input: any, ctx) => {
      const next = input && typeof input === 'object' ? { ...input } : input;
      if (next && typeof next === 'object') {
        for (const k of PATH_KEYS) if (typeof next[k] === 'string') next[k] = resolver.toAnalyzerPath(next[k]);
        for (const k of PATH_ARRAY_KEYS) {
          if (Array.isArray(next[k])) next[k] = next[k].map((p: unknown) => (typeof p === 'string' ? resolver.toAnalyzerPath(p) : p));
        }
      }
      return tool.call(next, ctx);
    },
  };
}


