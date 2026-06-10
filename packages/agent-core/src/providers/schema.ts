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

export function toolParametersJSONSchema(tool: Tool): Record<string, unknown> {
  if (tool.inputJSONSchema) return tool.inputJSONSchema;
  if (tool.inputSchema) {
    try {
      // zod v4 exposes a top-level JSON Schema emitter.
      const schema = (z as unknown as { toJSONSchema: (s: unknown) => Record<string, unknown> }).toJSONSchema(
        tool.inputSchema,
      );
      // Strip the $schema meta key — providers don't need it.
      const { $schema, ...rest } = schema as Record<string, unknown>;
      return rest;
    } catch {
      return EMPTY_OBJECT_SCHEMA;
    }
  }
  return EMPTY_OBJECT_SCHEMA;
}
