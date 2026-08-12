/**
 * The per-scan memoization bundle (perf P0-1 / P0-2). One instance is created in
 * `runScan` and threaded through discovery / enrichment / investigation / judge so
 * every consumer shares the SAME per-scan caches:
 *
 *   - `files`: host file CONTENT, so a repo file is read off disk once per scan
 *     instead of once per tool/judge call (the blocking `readFileSync` sites).
 *   - `tools`: MCP evidence tool RESULTS, so an identical repeat tool call
 *     (same tool + same args) returns the cached result instead of re-invoking
 *     the analyzer and re-paying the token cost.
 *
 * Scope discipline (why they cannot leak between scans): `createScanCaches()`
 * returns a brand-new object with empty Maps. `runScan` constructs it, passes it
 * by reference through the scan, and drops it on completion — nothing module-level
 * or global persists, so a second scan starts with empty caches and can never be
 * served stale content/results from a previous scan.
 */

import { FileContentCache } from './fileContentCache';
import { ToolResultCache } from './toolResultCache';

export interface ScanCaches {
  files: FileContentCache;
  tools: ToolResultCache;
}

export function createScanCaches(): ScanCaches {
  return { files: new FileContentCache(), tools: new ToolResultCache() };
}
