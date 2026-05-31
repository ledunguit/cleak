export type Verdict =
  | 'confirmed_leak'
  | 'likely_leak'
  | 'false_positive'
  | 'inconclusive'
  | 'unjudged'
  | string;

export interface LocationInfo {
  file?: string;
  line?: number;
  column?: number;
  [key: string]: unknown;
}

export interface RootCauseInfo {
  pattern_type?: string;
  description?: string;
  allocation_function?: string;
  allocation_line?: number;
  allocation_file?: string;
  missing_free_line?: number;
  missing_free_function?: string;
  root_cause_function?: string;
  root_cause_line?: number;
  root_cause_description?: string;
  [key: string]: unknown;
}

export interface FindingBase {
  finding_id?: string;
  bundleId?: string;
  candidate?: {
    summary?: string;
    file?: string;
    line?: number;
    confidence?: string;
    primary_tool?: string;
    evidence?: EvidenceItem[];
    path_constraints?: string[];
    [key: string]: unknown;
  };
  verdict?: {
    verdict?: Verdict;
    confidence?: string | number;
    why?: string;
    human_explanation?: string;
    fix_suggestions?: FixSuggestion[];
    missing_evidence?: string[];
    root_cause?: RootCauseInfo;
    [key: string]: unknown;
  };
  orchestrator_notes?: string[];
  [key: string]: unknown;
}

export interface EvidenceItem {
  tool?: string;
  kind?: string;
  confidence?: string;
  severity?: string;
  message?: string;
  location?: LocationInfo;
  [key: string]: unknown;
}

export interface FixSuggestion {
  summary?: string;
  rationale?: string;
  code_change_hint?: string;
  before_snippet?: string;
  after_snippet?: string;
  before_start_line?: number;
  after_start_line?: number;
  target_location?: { line?: number; [key: string]: unknown };
  unified_diff?: string;
  [key: string]: unknown;
}

export function verdictTagColor(verdict: Verdict | undefined | null): string {
  if (verdict === 'confirmed_leak') return 'red';
  if (verdict === 'likely_leak') return 'orange';
  if (verdict === 'false_positive') return 'green';
  return 'blue';
}

export function formatLocation(location: LocationInfo | undefined | null): string {
  if (!location) {
    return 'unknown';
  }
  if (location.line && location.column) {
    return `${location.file}:${location.line}:${location.column}`;
  }
  if (location.line) {
    return `${location.file}:${location.line}`;
  }
  return location.file || 'unknown';
}

export function buildVerdictCounts(findings: FindingBase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    const verdict: string = finding?.verdict?.verdict || 'unjudged';
    counts[verdict] = (counts[verdict] || 0) + 1;
  }
  return counts;
}
