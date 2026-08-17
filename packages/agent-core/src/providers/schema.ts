/**
 * Resolve a tool's input JSON Schema for the model: MCP tools carry one
 * verbatim (`inputJSONSchema`); domain tools carry a zod schema that we convert
 * once. Falls back to an empty object schema so a malformed tool never breaks
 * the whole request.
 */

import { z } from 'zod';
import type { Tool } from '../tool';

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

// Tool objects are stable module-level singletons reused across every turn of
// every queryLoop call (and across concurrent loops sharing the same tool
// catalog) — z.toJSONSchema() is deterministic per tool, so memoize by Tool
// identity instead of recomputing it on every single model call.
const jsonSchemaCache = new WeakMap<Tool, Record<string, unknown>>();

export function toolParametersJSONSchema(tool: Tool): Record<string, unknown> {
  if (tool.inputJSONSchema) return tool.inputJSONSchema;
  const cached = jsonSchemaCache.get(tool);
  if (cached) return cached;
  if (tool.inputSchema) {
    try {
      // zod v4 exposes a top-level JSON Schema emitter.
      const schema = (z as unknown as { toJSONSchema: (s: unknown) => Record<string, unknown> }).toJSONSchema(
        tool.inputSchema,
      );
      // Strip the $schema meta key — providers don't need it.
      const { $schema: _drop, ...rest } = schema as Record<string, unknown>;
      jsonSchemaCache.set(tool, rest);
      return rest;
    } catch {
      return EMPTY_OBJECT_SCHEMA;
    }
  }
  return EMPTY_OBJECT_SCHEMA;
}
