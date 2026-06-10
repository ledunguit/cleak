/**
 * In-memory leak-bundle store. Candidates are deduplicated by a hash of their
 * allocation site (or file:line), so re-scanning a file merges into the
 * existing bundle instead of creating a duplicate. Mirrors the control plane's
 * CandidateManager so both produce the same bundle ids and dedup behaviour.
 */

import type { LeakBundle, LeakCandidate, LeakEvidence } from '@mcpvul/common/types';
import { FindingStatus } from '@mcpvul/common/types';

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
  const hash = candidate.allocation_site || `${candidate.file_path}:${candidate.line_number}`;
  const fullHex = Buffer.from(hash).toString('hex');
  const suffix = fullHex.slice(-20) + fullHex.slice(0, 12);
  return `bundle_${suffix}`;
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
