/**
 * Per-scan host file-content memoization (perf P0-1).
 *
 * The orchestrator repeatedly hands the same repo files to content-based MCP tools
 * (discovery candidateScan, enrichment functionSummary/pathConstraints, the
 * Stage-A sub-agent tool wrappers, the read_file domain tool) and to the LLM judge.
 * Each site used to `readFileSync` the file fresh, blocking the main thread every
 * time — a hot repo file could be read tens of times per scan. This cache memoizes
 * content per (resolved absolute path + size/mtimeMs stamp) so each unchanged file
 * is read ONCE per scan.
 *
 * Scope discipline: an instance is created per scan in `runScan` and dropped when
 * the scan finishes — the Maps are empty at construction and are never shared across
 * scans, so a cached file from one repo can never be served to another scan.
 *
 * The stamp is re-checked on every read (one cheap `statSync`, no content read), so
 * a file that legitimately changes mid-scan (size or mtime changes) is re-read; an
 * unchanged file pays a stat but never a second content read.
 */

import { statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface CacheEntry {
  /** `size:mtimeMs` stamp the cached content was read under. */
  stamp: string;
  content: string | null;
}

export class FileContentCache {
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * Read `path` through the cache. Same contract as `readFileSafe` (string content,
   * or null when the file can't be read). Re-reads only when the file's
   * size/mtimeMs stamp differs from the cached stamp.
   */
  read(path: string): string | null {
    const abs = resolve(path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      // File missing/unreadable → drop any stale entry (a later stat may succeed).
      this.entries.delete(abs);
      return null;
    }
    const stamp = `${st.size}:${st.mtimeMs}`;
    const hit = this.entries.get(abs);
    if (hit && hit.stamp === stamp) return hit.content;

    let content: string | null;
    try {
      content = readFileSync(abs, 'utf-8');
    } catch {
      content = null;
    }
    this.entries.set(abs, { stamp, content });
    return content;
  }

  /** Number of distinct files currently cached (diagnostics / tests). */
  get size(): number {
    return this.entries.size;
  }
}
