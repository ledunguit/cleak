import { Injectable } from '@nestjs/common';
import { LeakBundle, LeakCandidate, FindingStatus } from '@mcpvul/common';

@Injectable()
export class CandidateManagerService {
  private bundles: Map<string, LeakBundle> = new Map();

  ingest(candidate: LeakCandidate): LeakBundle {
    const bundleId = this.computeBundleId(candidate);
    const existing = this.bundles.get(bundleId);
    if (existing) {
      return existing;
    }
    const bundle: LeakBundle = {
      bundleId,
      candidate,
      evidence: [],
      status: FindingStatus.PENDING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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

  clear(): void {
    this.bundles.clear();
  }

  private computeBundleId(candidate: LeakCandidate): string {
    // Hash allocation site for dedup — use full hash to avoid collision
    const hash = candidate.allocation_site || `${candidate.file_path}:${candidate.line_number}`;
    const fullHex = Buffer.from(hash).toString('hex');
    const suffix = fullHex.slice(-20) + fullHex.slice(0, 12);
    return `bundle_${suffix}`;
  }
}
