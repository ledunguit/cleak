/**
 * The Tool abstraction. A tool carries either a zod `inputSchema` (domain
 * tools) or an `inputJSONSchema` (MCP tools — passed through verbatim, no zod
 * conversion), plus read-only/concurrency predicates that drive the loop's
 * dispatch partitioning, a permission gate, and a result→tool_result mapper.
 *
 * `buildTool()` fills fail-closed defaults (assume write + not concurrency-safe),
 * so a definition only states what differs from the safe baseline.
 */

import type { z } from 'zod';
import type { ContentBlock } from './types';

export type PermissionBehavior = 'allow' | 'ask' | 'deny';

export interface PermissionResult {
  behavior: PermissionBehavior;
  reason?: string;
}

/** Execution environment handed to every tool call (trimmed ToolUseContext). */
export interface ToolCtx {
  abortSignal?: AbortSignal;
  /** Resolve an 'ask' permission interactively (TUI) or by policy (headless). */
  requestPermission?: (req: { id: string; name: string; input: unknown }) => Promise<'allow' | 'deny'>;
  emit?: (event: unknown) => void;
  log?: (msg: string) => void;
  cwd?: string;
  /** Shared, mutable scan state (candidate store, accumulated context, etc.). */
  state?: Record<string, unknown>;
}

export interface Tool<I = any, O = unknown> {
  name: string;
  description: string;
  /** Domain tools: zod schema (converted to JSON Schema for the model). */
  inputSchema?: z.ZodType<I>;
  /** MCP tools: JSON Schema passed straight through (no zod conversion). */
  inputJSONSchema?: Record<string, unknown>;
  isReadOnly: (input: I) => boolean;
  isConcurrencySafe: (input: I) => boolean;
  checkPermissions: (input: I, ctx: ToolCtx) => Promise<PermissionResult>;
  call: (input: I, ctx: ToolCtx) => Promise<O>;
  mapResultToBlock: (output: O, toolUseId: string) => ContentBlock;
  /** Short present-tense label for the ToolUseCard, e.g. "functionSummary make_buf @ main.c:12". */
  renderTitle?: (input: Partial<I>) => string;
  maxResultSizeChars: number;
}

export type ToolDef<I, O> = Partial<Tool<I, O>> &
  Pick<Tool<I, O>, 'name' | 'description' | 'call'>;

export const DEFAULT_MAX_RESULT_CHARS = 100_000;

export function buildTool<I = any, O = unknown>(def: ToolDef<I, O>): Tool<I, O> {
  return {
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    mapResultToBlock: (output: O, toolUseId: string): ContentBlock => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: typeof output === 'string' ? output : JSON.stringify(output ?? null),
    }),
    maxResultSizeChars: DEFAULT_MAX_RESULT_CHARS,
    ...def,
  } as Tool<I, O>;
}

export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

/** Truncate an oversized stringified tool result, leaving a marker (mirrors MCP truncation). */
export function truncateResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  return `${head}\n\n…[truncated ${text.length - maxChars} of ${text.length} chars]`;
}
