// Report types

export interface ReportSummary {
  totalCandidates: number;
  confirmedLeaks: number;
  likelyLeaks: number;
  falsePositives: number;
  totalBytesLost: number;
  toolsUsed: string[];
  durationSec: number;
}

export interface LeakCandidate {
  id: string;
  function_name: string;
  file_path: string;
  line_number: number;
  allocation_site: string;
  allocation_type: string;
  confidence: string;
  context: string;
}

export interface LeakEvidence {
  tool: string;
  runId: string;
  function_name: string;
  file_path: string;
  line_number: number;
  bytes_lost: number;
  blocks_lost: number;
  severity: string;
  stack_trace: string;
}

export interface VerdictResult {
  verdict: string;
  confidence: number;
  explanation: string;
  evidence: string[];
  tool: string;
}

export interface LeakBundle {
  bundleId: string;
  status: string;
  candidate: LeakCandidate;
  verdict?: VerdictResult;
  evidence: LeakEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface StructuredReport {
  scanId: string;
  bundles: LeakBundle[];
  summary: ReportSummary;
  metadata: Record<string, any>;
}
