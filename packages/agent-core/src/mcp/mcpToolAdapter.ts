/**
 * Wrap a discovered remote MCP tool as a local agent-core Tool: the remote JSON
 * Schema becomes `inputJSONSchema` verbatim (no zod conversion), `call`
 * delegates to `client.callTool`, and read-only / concurrency flags come from a
 * caller-supplied policy (the analyzers don't currently set MCP annotations).
 */

import { buildTool, type Tool } from '../tool';
import type { McpClient, RemoteTool } from './mcpClient';

export interface McpToolFlags {
  /** Default true — analysis tools don't mutate the repo. */
  readOnly?: boolean;
  /** Default false (fail-closed) — heavy/process-spawning tools must run serially. */
  concurrencySafe?: boolean;
  /** Require interactive approval before running (e.g. builds / sanitizer runs that execute code). */
  ask?: boolean;
  /** Cap the tool result size (chars) to keep the agent context small for local models. */
  maxResultChars?: number;
  /** Per-call timeout (ms) so a hung analyzer call fails fast instead of blocking the loop. */
  timeoutMs?: number;
}

export type McpToolFlagResolver = (toolName: string) => McpToolFlags;

export function wrapMcpTool(
  client: McpClient,
  remote: RemoteTool,
  flags: McpToolFlags = {},
): Tool {
  const readOnly = flags.readOnly ?? true;
  const concurrencySafe = flags.concurrencySafe ?? false;
  const behavior: 'allow' | 'ask' = flags.ask ? 'ask' : readOnly ? 'allow' : 'ask';
  const maxResult =
    typeof remote._meta?.['anthropic/maxResultSizeChars'] === 'number'
      ? (remote._meta['anthropic/maxResultSizeChars'] as number)
      : flags.maxResultChars;

  return buildTool({
    name: remote.name,
    description: remote.description ?? remote.name,
    inputJSONSchema: remote.inputSchema,
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => concurrencySafe,
    checkPermissions: async () => ({ behavior }),
    call: async (input, ctx) =>
      client.callTool(remote.name, (input ?? {}) as Record<string, unknown>, {
        signal: ctx.abortSignal,
        timeoutMs: flags.timeoutMs,
      }),
    renderTitle: (input) => renderMcpTitle(remote.name, input),
    ...(maxResult ? { maxResultSizeChars: maxResult } : {}),
  });
}

/** Discover all tools on a client and wrap each, applying per-tool flags. */
export async function loadMcpTools(
  client: McpClient,
  resolveFlags: McpToolFlagResolver = () => ({}),
): Promise<Tool[]> {
  const remote = await client.listTools();
  return remote.map((t) => wrapMcpTool(client, t, resolveFlags(t.name)));
}

function renderMcpTitle(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name;
  const file = (input.filePath ?? input.rootPath ?? input.projectPath ?? input.binaryPath) as string | undefined;
  const fn = input.functionName as string | undefined;
  const line = input.lineNumber as number | undefined;
  const loc = file ? `${shortPath(file)}${line ? `:${line}` : ''}` : undefined;
  if (fn && loc) return `${name} ${fn} @ ${loc}`;
  if (fn) return `${name} ${fn}`;
  if (loc) return `${name} ${loc}`;
  return name;
}

function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}
