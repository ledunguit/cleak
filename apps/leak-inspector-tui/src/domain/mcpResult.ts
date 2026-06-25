/**
 * An MCP tool result may arrive as an already-parsed object or as a JSON string
 * (the SDK returns the latter for text content). `coerceToObject` returns a plain
 * object for safe field access and never throws (malformed/empty → {}). Shared by
 * the static-context and dynamic-evidence capture wrappers, which both fold raw
 * tool output into per-bundle state.
 */
export function coerceToObject(result: unknown): Record<string, any> {
  if (result && typeof result === 'object') return result as Record<string, any>;
  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch {
      return {};
    }
  }
  return {};
}
