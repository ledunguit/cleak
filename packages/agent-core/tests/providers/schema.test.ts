import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { toolParametersJSONSchema } from '../../src/providers/schema';
import type { Tool } from '../../src/tool';

describe('toolParametersJSONSchema — memoized per Tool identity', () => {
  test('a zod-schema tool returns the exact same cached object on repeat calls, not a freshly-converted copy', () => {
    // z.toJSONSchema can't be spied on directly (ESM namespace isn't
    // configurable), so memoization is verified via reference identity
    // instead: without caching, each call would build a brand-new object
    // (deep-equal but never `===`); with caching, every call after the first
    // returns the SAME object reference.
    const tool = {
      name: 'test-tool',
      inputSchema: z.object({ path: z.string() }),
    } as unknown as Tool;

    const first = toolParametersJSONSchema(tool);
    const second = toolParametersJSONSchema(tool);
    const third = toolParametersJSONSchema(tool);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test('two different tool instances are converted independently (no cross-tool collision)', () => {
    const toolA = { name: 'a', inputSchema: z.object({ x: z.string() }) } as unknown as Tool;
    const toolB = { name: 'b', inputSchema: z.object({ y: z.number() }) } as unknown as Tool;

    const a = toolParametersJSONSchema(toolA);
    const b = toolParametersJSONSchema(toolB);

    expect(a).not.toEqual(b);
  });

  test('an MCP tool with inputJSONSchema is returned verbatim (same reference), no zod conversion involved', () => {
    const tool = {
      name: 'mcp-tool',
      inputJSONSchema: { type: 'object', properties: { foo: { type: 'string' } } },
    } as unknown as Tool;

    const result = toolParametersJSONSchema(tool);

    expect(result).toBe(tool.inputJSONSchema);
  });
});
