/**
 * Standard MCP tool response wrapper. Wraps any result into the
 * `{ content, structuredContent }` shape the MCP SDK expects from a tool
 * handler. Both the static and dynamic analyzers use this identical helper.
 */
export const ok = (result: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }],
  structuredContent: (result ?? {}) as Record<string, unknown>,
});
