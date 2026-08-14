/**
 * Redaction helpers shared by the MCP transport (`mcp-http.ts`) and
 * `tool-instrumentation.ts`. Several tools (`functionSummary`, `pathConstraints`,
 * `candidateScan`) send full source file content inline as an argument — logs
 * must never echo that back, only a size/shape-preserving preview.
 */

const DEFAULT_MAX_LEN = 60;

/** One short, safe preview string per argument: `key=value, key=[n], key=…`. */
export function previewArgs(args: Record<string, unknown> | undefined, opts: { maxLen?: number } = {}): Record<string, string> {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === 'string') {
      out[k] = v.length > maxLen ? `${v.slice(0, maxLen)}…(${v.length} chars)` : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v);
    } else if (Array.isArray(v)) {
      out[k] = `[${v.length}]`;
    } else if (v && typeof v === 'object') {
      out[k] = `{${Object.keys(v as object).length} keys}`;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

/** A single-line label for a JSON-RPC `tools/call` body — `toolName(k=v, …)` or the bare method for anything else. */
export function describeMcpCall(body: unknown): string {
  const b = body as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | undefined;
  if (!b?.method) return 'unknown';
  if (b.method !== 'tools/call' || !b.params?.name) return b.method;
  const preview = Object.entries(previewArgs(b.params.arguments))
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `${b.params.name}(${preview})`;
}

/**
 * A result summary safe to log on a `*_finished` event — counts/sizes instead of
 * the full payload (which may itself embed source content, e.g. `functionSummary`
 * echoing back matched lines).
 */
export function summarizeResult(result: unknown, opts: { maxKeys?: number } = {}): Record<string, unknown> {
  const maxKeys = opts.maxKeys ?? 12;
  if (result == null) return { result: 'null' };
  if (Array.isArray(result)) return { resultLength: result.length };
  if (typeof result !== 'object') return { result: previewArgs({ v: result }).v };
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (i++ >= maxKeys) break;
    if (Array.isArray(v)) out[k] = `[${v.length}]`;
    else if (typeof v === 'string') out[k] = v.length > DEFAULT_MAX_LEN ? `${v.slice(0, DEFAULT_MAX_LEN)}…(${v.length} chars)` : v;
    else if (typeof v === 'object' && v !== null) out[k] = `{${Object.keys(v).length} keys}`;
    else out[k] = v;
  }
  return out;
}
