/**
 * `FindingView` — the single view-model the findings table + verdict card render,
 * normalized from EITHER an in-memory `LeakBundle` (post-scan) or a `snapshot.json`
 * finding (historical / eval). The UI is written once against this shape and never
 * branches on source. Fields are optional where the data may be absent (older
 * snapshots, heuristic-only verdicts) so the card degrades gracefully.
 */
import type { LeakBundle } from '@cleak/common/types';

export interface FindingEvidenceView {
  tool: string;
  bytesLost: number;
  leakKind?: string | null;
  correlationMethod?: string;
  correlatedToCandidate?: boolean;
  allocSite?: { file: string; line: number; function: string } | null;
}
export interface FindingConsensusView {
  agreement: number;
  samples: { verdict: string; confidence: number }[];
  overridden: boolean;
  fusion?: { static: string; dynamic: string } | null;
}
export interface FindingStaticView {
  ownership?: { role: string; carrier?: any; rationale?: string } | null;
  allocFreePairs: { variable: string; allocLine?: number; freeLine?: number | null; status: string }[];
  feasiblePaths: { narrative: string; leakRisk?: string; reachable?: boolean }[];
}
export interface FindingView {
  id: string;
  function: string;
  file: string;
  line: number;
  allocationType: string;
  verdict: string;
  confidence: number;
  verdictTool: string;
  dynamicCoverage: string;
  explanation: string;
  repairSuggestion?: string;
  rootCause?: { patternType?: string; description?: string; missingFreeFunction?: string; missingFreeLine?: number } | null;
  repairDiff?: { filePath?: string; startLine?: number; originalLines: string[]; suggestedLines: string[] } | null;
  evidence: FindingEvidenceView[];
  consensus?: FindingConsensusView;
  staticEvidence?: FindingStaticView;
}

/** Sort key: more severe verdicts first (confirmed > likely > uncertain > FP). */
export function verdictSeverityRank(verdict: string): number {
  switch (verdict) {
    case 'confirmed_leak':
      return 5;
    case 'likely_leak':
      return 4;
    case 'uncertain':
      return 3;
    case 'likely_false_positive':
      return 2;
    case 'false_positive':
      return 1;
    default:
      return 0;
  }
}

const num = (x: any, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/** Normalize a `snapshot.json` finding (snake_case, tolerant of missing Phase-0 fields). */
export function snapshotFindingToView(f: any): FindingView {
  const view: FindingView = {
    id: String(f.id ?? ''),
    function: String(f.function ?? '?'),
    file: String(f.file ?? ''),
    line: num(f.line),
    allocationType: String(f.allocation_type ?? ''),
    verdict: String(f.verdict ?? 'pending'),
    confidence: num(f.confidence),
    verdictTool: String(f.verdict_tool ?? ''),
    dynamicCoverage: String(f.dynamic_coverage ?? 'dynamic_off'),
    explanation: String(f.explanation ?? ''),
    repairSuggestion: f.repair_suggestion || undefined,
    rootCause: f.root_cause ?? undefined,
    repairDiff: f.repair_diff
      ? {
          filePath: f.repair_diff.filePath,
          startLine: f.repair_diff.startLine,
          originalLines: f.repair_diff.originalLines ?? [],
          suggestedLines: f.repair_diff.suggestedLines ?? [],
        }
      : undefined,
    evidence: (f.evidence ?? []).map((e: any) => ({
      tool: String(e.tool ?? ''),
      bytesLost: num(e.bytes_lost),
      leakKind: e.leak_kind ?? null,
      correlationMethod: e.correlation_method,
      correlatedToCandidate: e.correlated_to_candidate,
      allocSite: e.alloc_site ?? null,
    })),
  };
  if (f.consensus) {
    view.consensus = {
      agreement: num(f.consensus.agreement),
      samples: f.consensus.samples ?? [],
      overridden: !!f.consensus.overridden,
      fusion: f.consensus.evidence_fusion ?? null,
    };
  }
  if (f.static_evidence) {
    view.staticEvidence = {
      ownership: f.static_evidence.ownership ?? null,
      allocFreePairs: (f.static_evidence.alloc_free_pairs ?? []).map((p: any) => ({
        variable: p.variable,
        allocLine: p.alloc_line,
        freeLine: p.free_line,
        status: p.status,
      })),
      feasiblePaths: (f.static_evidence.feasible_leak_paths ?? []).map((p: any) => ({
        narrative: p.narrative,
        leakRisk: p.leak_risk,
        reachable: p.reachable,
      })),
    };
  }
  return view;
}

/** Normalize an in-memory `LeakBundle` (camelCase). Kept for a future live path;
 * unit-tested but the UI v1 routes through `snapshotFindingToView` for parity. */
export function bundleToFindingView(b: LeakBundle): FindingView {
  const v: any = b.verdict;
  const view: FindingView = {
    id: b.bundleId,
    function: b.candidate.function_name,
    file: b.candidate.file_path,
    line: b.candidate.line_number,
    allocationType: b.candidate.allocation_type,
    verdict: v?.verdict ?? 'pending',
    confidence: num(v?.confidence),
    verdictTool: v?.tool ?? '',
    dynamicCoverage: b.dynamicCoverage ?? 'dynamic_off',
    explanation: v?.explanation ?? '',
    repairSuggestion: v?.repair_suggestion,
    rootCause: v?.rootCause,
    repairDiff: v?.repairDiff
      ? { filePath: v.repairDiff.filePath, startLine: v.repairDiff.startLine, originalLines: v.repairDiff.originalLines ?? [], suggestedLines: v.repairDiff.suggestedLines ?? [] }
      : undefined,
    evidence: (b.evidence ?? []).map((e) => ({
      tool: e.tool,
      bytesLost: num(e.bytes_lost),
      leakKind: e.leakKind ?? null,
      correlationMethod: e.correlationMethod,
      correlatedToCandidate: e.correlatedToCandidate,
      allocSite: e.allocSite ?? null,
    })),
  };
  if (v && Array.isArray(v.samples)) {
    view.consensus = { agreement: num(v.agreement), samples: v.samples, overridden: !!v.overridden, fusion: v.evidenceFusion ?? null };
  }
  const se = b.staticEvidence;
  if (se) {
    view.staticEvidence = {
      ownership: se.ownership ? { role: se.ownership.role, carrier: se.ownership.ownershipCarrier, rationale: se.ownership.rationale } : null,
      allocFreePairs: (se.allocFreePairs ?? []).map((p) => ({ variable: p.variable, allocLine: p.allocLine, freeLine: p.freeLine, status: p.status })),
      feasiblePaths: (se.feasibleLeakPaths ?? []).map((p) => ({ narrative: p.narrative, leakRisk: p.leakRisk, reachable: p.reachable })),
    };
  }
  return view;
}
