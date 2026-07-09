import type { LeakConfidence, FindingStatus } from './enums';
import type { LeakEvidence, StaticLeakEvidence, DynamicCoverage } from './evidence';
import type { VerdictResult } from './verdict';

export interface LeakCandidate {
  id: string;
  function_name: string;
  file_path: string;
  line_number: number;
  allocation_site: string;
  allocation_type: string;
  confidence: LeakConfidence;
  context: string;
}

export interface LeakBundle {
  bundleId: string;
  candidate: LeakCandidate;
  verdict?: VerdictResult;
  evidence: LeakEvidence[];
  /**
   * Rich, typed static evidence assembled from the static-analyzer tools
   * (ownership summary, alloc→free pairing, feasible leak paths). Optional so
   * older serialized reports still parse and bundles judged before this field
   * existed remain valid.
   */
  staticEvidence?: StaticLeakEvidence;
  /**
   * What the dynamic stage established for this candidate (deterministic, set after
   * the dynamic run reconciles). Optional so pre-existing reports still parse and
   * `no_llm`/dynamic-off bundles stay valid.
   */
  dynamicCoverage?: DynamicCoverage;
  status: FindingStatus;
  createdAt: string;
  updatedAt: string;
}
