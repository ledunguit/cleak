/**
 * In-memory leak-bundle store. Candidates are deduplicated by a hash of their
 * allocation site (or file:line), so re-scanning a file merges into the
 * existing bundle instead of creating a duplicate. Mirrors the control plane's
 * CandidateManager so both produce the same bundle ids and dedup behaviour.
 */

import { createHash } from 'node:crypto';
import type { LeakBundle, LeakCandidate, LeakEvidence } from '@cleak/common/types';
import { FindingStatus } from '@cleak/common/types';

export class CandidateManager {
  private bundles = new Map<string, LeakBundle>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  ingest(candidate: LeakCandidate): LeakBundle {
    const bundleId = computeBundleId(candidate);
    const existing = this.bundles.get(bundleId);
    if (existing) return existing;
    const ts = this.now();
    const bundle: LeakBundle = {
      bundleId,
      candidate,
      evidence: [],
      status: FindingStatus.PENDING,
      createdAt: ts,
      updatedAt: ts,
    };
    this.bundles.set(bundleId, bundle);
    return bundle;
  }

  getBundle(bundleId: string): LeakBundle | undefined {
    return this.bundles.get(bundleId);
  }

  getAllBundles(): LeakBundle[] {
    return Array.from(this.bundles.values());
  }

  attachEvidence(bundleId: string, evidence: LeakEvidence): void {
    const b = this.bundles.get(bundleId);
    if (!b) return;
    b.evidence.push(evidence);
    b.updatedAt = this.now();
  }

  clear(): void {
    this.bundles.clear();
  }
}

export function computeBundleId(candidate: LeakCandidate): string {
  const key = candidate.allocation_site || `${candidate.file_path}:${candidate.line_number}`;
  // Was `Buffer.from(key).toString('hex').slice(-20) + .slice(0, 12)` — for any `key`
  // longer than 16 chars (every real-project allocation_site: full file path + line +
  // allocator name) that keeps only the string's first 6 and last 10 characters, so
  // candidates sharing a common path prefix (all of them, within one repo) and the same
  // allocator-name suffix (e.g. every `curlx_malloc` call in the whole codebase)
  // collapsed onto the IDENTICAL bundleId regardless of file or line — confirmed on
  // curl_1098e104: 622 distinct raw candidates ingested down to 65 surviving bundles.
  // A real digest over the full key has no such blind spot.
  const digest = createHash('sha1').update(key).digest('hex');
  return `bundle_${digest}`;
}

/** Normalize a raw analyzer candidate (camelCase) into the snake_case LeakCandidate shape. */
export function normalizeCandidate(c: any, toHostPath: (p: string) => string): LeakCandidate {
  return {
    id: c.id,
    function_name: c.functionName || c.function_name || '',
    file_path: toHostPath(c.filePath || c.file_path || ''),
    line_number: c.lineNumber ?? c.line_number ?? 0,
    allocation_site: c.allocationSite || c.allocation_site || '',
    allocation_type: c.allocationType || c.allocation_type || '',
    confidence: c.confidence || 'medium',
    context: c.context || '',
  };
}
