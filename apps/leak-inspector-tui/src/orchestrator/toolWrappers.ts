/**
 * Shared tool wrappers used by the investigation orchestrators. The workspace
 * lives on the host, so static (content-based) tools get the file content injected
 * host-side, and dynamic tools get their filesystem paths translated host→analyzer.
 */

import { isAbsolute, resolve } from 'node:path';
import type { Tool } from '@mcpvul/agent-core';
import type { RunConfig } from '../config';
import type { ProviderSettings } from '@mcpvul/agent-core';
import { readFileSafe } from '../domain/fileWalk';

/**
 * Inject the host file's content into a content-based MCP tool call. The agent
 * passes a `filePath` (host path, absolute or repo-relative); we read it on the
 * host and add `content`, so the stateless analyzer never needs filesystem access.
 */
export function withHostContent(tool: Tool, repoPath: string): Tool {
  return {
    ...tool,
    call: (input: any, ctx) => {
      const next = input && typeof input === 'object' ? { ...input } : input;
      if (next && typeof next === 'object' && typeof next.filePath === 'string') {
        const abs = isAbsolute(next.filePath) ? next.filePath : resolve(repoPath, next.filePath);
        if (!next.content) {
          const content = readFileSafe(abs);
          if (content !== null) next.content = content;
        }
        next.filePath = abs;
      }
      return tool.call(next, ctx);
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
  const PATH_KEYS = ['projectPath', 'binaryPath', 'cwd', 'workdir'];
  return {
    ...tool,
    call: (input: any, ctx) => {
      const next = input && typeof input === 'object' ? { ...input } : input;
      if (next && typeof next === 'object') {
        for (const k of PATH_KEYS) if (typeof next[k] === 'string') next[k] = resolver.toAnalyzerPath(next[k]);
      }
      return tool.call(next, ctx);
    },
  };
}

/** Map the app's resolved LLM config to the agent-core provider settings shape. */
export function toProviderSettings(cfg: RunConfig): ProviderSettings {
  return {
    provider: cfg.llm.provider,
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    maxTokens: cfg.llm.maxTokens,
    timeoutMs: cfg.llm.timeoutMs,
    idleTimeoutMs: cfg.llm.idleTimeoutMs,
    connectTimeoutMs: cfg.llm.connectTimeoutMs,
    retries: cfg.llm.retries,
  };
}
