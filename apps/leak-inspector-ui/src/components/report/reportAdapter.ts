import type {
  StructuredReport,
  LeakBundle,
  LeakEvidence,
  ReportSummary,
  VerdictResult,
} from '@/types';
import type {
  FindingBase,
  EvidenceItem,
  FixSuggestion,
  RootCauseInfo,
} from './reportFormat';

export interface AdaptedReportData {
  scanId: string;
  bundles: LeakBundle[];
  findings: FindingBase[];
  summary: ReportSummary | { totalCandidates?: number; [key: string]: unknown };
  metadata: Record<string, any>;
  repo_path?: string;
  performanceSummary?: Record<string, unknown>;
  judgeSummary?: Record<string, unknown>;
  [key: string]: unknown;
}

function mapEvidence(e: LeakEvidence): EvidenceItem {
  return {
    tool: e.tool,
    kind: e.tool,
    confidence:
      e.severity === 'high'
        ? 'high'
        : e.severity === 'medium'
          ? 'medium'
          : 'low',
    severity: e.severity,
    message:
      e.raw_output ||
      `${e.tool} reported ${e.bytes_lost} bytes lost in ${e.function_name} at ${e.file_path}:${e.line_number}`,
    location: {
      file: e.file_path,
      line: e.line_number,
    },
  };
}

function mapBundleToFinding(bundle: LeakBundle): FindingBase {
  const candidate = bundle.candidate;
  const verdict = bundle.verdict;

  return {
    finding_id: bundle.bundleId,
    bundleId: bundle.bundleId,
    candidate: {
      summary: candidate.function_name,
      file: candidate.file_path,
      line: candidate.line_number,
      confidence: candidate.confidence,
      evidence: bundle.evidence.map(mapEvidence),
      primary_tool: bundle.evidence[0]?.tool || 'heuristic',
      path_constraints: [],
    },
    verdict: verdict
      ? {
          verdict:
            verdict.verdict === 'uncertain'
              ? ('inconclusive' as const)
              : verdict.verdict,
          confidence: verdict.confidence,
          human_explanation: verdict.explanation,
          why: verdict.explanation,
          fix_suggestions: buildFixSuggestions(verdict),
          missing_evidence: [],
          root_cause: buildRootCause(verdict),
        }
      : undefined,
    orchestrator_notes: [],
  };
}

function buildRootCause(
  verdict?: VerdictResult,
): RootCauseInfo | undefined {
  const rc = verdict?.rootCause;
  if (!rc) return undefined;

  // Normalise the backend's camelCase root-cause payload into the snake_case
  // shape the report UI consumes elsewhere.
  return {
    pattern_type: rc.patternType,
    description: rc.description,
    allocation_function: rc.allocationFunction,
    allocation_line: rc.allocationLine,
    allocation_file: rc.allocationFile,
    missing_free_line: rc.missingFreeLine,
    missing_free_function: rc.missingFreeFunction,
    root_cause_function: rc.rootCauseFunction,
    root_cause_line: rc.rootCauseLine,
    root_cause_description: rc.rootCauseDescription,
  };
}

function buildFixSuggestions(
  verdict?: VerdictResult,
): FixSuggestion[] {
  if (!verdict) return [];

  // Prefer the structured repair diff produced by the LLM judge — renders as a
  // real before/after diff instead of relying on parsing free-text markdown.
  const diff = verdict.repairDiff;
  if (diff && ((diff.originalLines?.length ?? 0) > 0 || (diff.suggestedLines?.length ?? 0) > 0)) {
    return [
      {
        summary: diff.description || verdict.repair_suggestion || 'Suggested fix',
        rationale: verdict.rootCause?.rootCauseDescription || verdict.rootCause?.description,
        before_snippet: (diff.originalLines || []).join('\n'),
        after_snippet: (diff.suggestedLines || []).join('\n'),
        before_start_line: diff.startLine,
        after_start_line: diff.startLine,
      },
    ];
  }

  const repairSuggestion = verdict.repair_suggestion;
  if (!repairSuggestion) return [];

  // Try to detect diff blocks in the suggestion text
  const diffMatch = repairSuggestion.match(
    /```diff\n([\s\S]*?)```/,
  );
  if (diffMatch) {
    return [
      {
        summary: repairSuggestion.replace(/```[\s\S]*?```/, '').trim(),
        unified_diff: diffMatch[1].trim(),
      },
    ];
  }

  // Try to detect generic code blocks
  const codeMatch = repairSuggestion.match(/```\w*\n([\s\S]*?)```/);
  if (codeMatch) {
    return [
      {
        summary: repairSuggestion.replace(/```[\s\S]*?```/, '').trim(),
        after_snippet: codeMatch[1].trim(),
      },
    ];
  }

  return [{ summary: repairSuggestion }];
}

export function mapStructuredReport(
  report: StructuredReport,
): AdaptedReportData {
  return {
    scanId: report.scanId,
    bundles: report.bundles,
    findings: report.bundles.map(mapBundleToFinding),
    summary: report.summary,
    metadata: report.metadata,
    repo_path: report.metadata?.sourceWorkspacePath || report.metadata?.workspacePath,
    materialized_repo_path: report.metadata?.materializedWorkspacePath,
  };
}
