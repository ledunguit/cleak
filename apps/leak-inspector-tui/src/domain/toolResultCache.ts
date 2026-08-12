/**
 * Per-scan tool-result memoization for repeated MCP evidence calls (perf P0-2).
 *
 * Stage-A static sub-agents repeatedly invoke the same evidence tools
 * (functionSummary / pathConstraints / astScan / ownershipConventions) for the
 * same candidates — a ~9x token-cost lever in the eval. This cache keys each
 * successful tool result by `(toolName + canonical args)` so an identical repeat
 * call returns the cached result instead of re-invoking the MCP server (saving
 * the round-trip AND the token cost of a second result in the agent transcript).
 *
 * The key deliberately DROPS the `content` field: content is implied by `filePath`
 * (the per-scan file-content cache serves the same bytes for the same path), and
 * dropping it lets the deterministic enrichment stage (scanController) and the
 * Stage-A sub-agents agree on the same key for the same analysis request — so a
 * tool result the orchestrator already holds is reused instead of re-requested.
 *
 * Scope discipline: one instance per scan (created in `runScan`), dropped when the
 * scan completes — an empty Map at construction, never shared across scans, so a
 * result from one repo/candidate set can never be served to another scan.
 */

/** Deterministic string key for a tool call — stable JSON (sorted keys), `content` excluded. */
export function toolCallKey(toolName: string, args: unknown): string {
  return `${toolName} ${stableStringify(stripContent(args))}`;
}

function stripContent(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripContent);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'content') continue;
      out[k] = stripContent(val);
    }
    return out;
  }
  return v;
}

function stableStringify(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Bounded FIFO so an adversarial/very large scan cannot grow the cache unbounded. */
const MAX_ENTRIES = 10_000;

export class ToolResultCache {
  private readonly entries = new Map<string, unknown>();

  /** Cached successful result for `(toolName, args)`, or undefined on a miss. */
  get(toolName: string, args: unknown): unknown {
    return this.entries.get(toolCallKey(toolName, args));
  }

  has(toolName: string, args: unknown): boolean {
    return this.entries.has(toolCallKey(toolName, args));
  }

  set(toolName: string, args: unknown, result: unknown): void {
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(toolCallKey(toolName, args))) {
      // Evict the oldest entry (Map iteration order = insertion order).
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(toolCallKey(toolName, args), result);
  }

  /** Number of cached tool results (diagnostics / tests). */
  get size(): number {
    return this.entries.size;
  }
}
