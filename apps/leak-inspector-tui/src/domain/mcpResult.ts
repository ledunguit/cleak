/**
 * An MCP tool result may arrive as an already-parsed object or as a JSON string
 * (the SDK returns the latter for text content). `coerceToObject` returns a plain
 * object for safe field access and never throws (malformed/empty → {}). Shared by
 * the static-context and dynamic-evidence capture wrappers, which both fold raw
 * tool output into per-bundle state.
 *
 * @template T - The expected response type (defaults to Record<string, unknown>).
 *               Use typed MCP response interfaces from static/dynamic analyzers
 *               for compile-time safety.
 */
export function coerceToObject<T extends Record<string, unknown> = Record<string, unknown>>(result: unknown): T {
  if (result && typeof result === 'object') return result as T;
  if (typeof result === 'string') {
    try {
      return JSON.parse(result) as T;
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}
