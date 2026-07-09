import type { ScanReport } from '../../types';

export function toSnapshot(report: ScanReport & Record<string, any>): string {
  const snapshot = {
    scan_id: report.scanId,
    repo_path: report.metadata?.sourceWorkspacePath || report.metadata?.workspacePath,
    materialized_repo_path: report.metadata?.materializedWorkspacePath || report.metadata?.workspacePath,
    generated_at: report.metadata?.completedAt || new Date().toISOString(),
    finding_count: report.bundles.length,
    confirmed_leak_count: report.summary.confirmedLeaks,
    likely_leak_count: report.summary.likelyLeaks,
    evidence_count: report.bundles.reduce((sum, bundle) => sum + bundle.evidence.length, 0),
    tools_used: report.summary.toolsUsed,
    build_plan: report.buildPlan || null,
    investigation_plan: report.investigationPlan || null,
    agent_decisions: report.agentDecisions || [],
    dynamic_execution_plan: report.dynamicExecutionPlan || null,
    findings: report.bundles.map((bundle) => {
      const v: any = bundle.verdict;
      const finding: any = {
        id: bundle.bundleId,
        function: bundle.candidate.function_name,
        file: bundle.candidate.file_path,
        line: bundle.candidate.line_number,
        allocation_type: bundle.candidate.allocation_type,
        verdict: bundle.verdict?.verdict || 'pending',
        verdict_tool: bundle.verdict?.tool || '',
        dynamic_coverage: bundle.dynamicCoverage || 'dynamic_off',
        confidence: bundle.verdict?.confidence || 0,
        explanation: bundle.verdict?.explanation || '',
        repair_suggestion: bundle.verdict?.repair_suggestion || '',
        root_cause: bundle.verdict?.rootCause || null,
        repair_diff: bundle.verdict?.repairDiff || null,
        snippet: bundle.candidate.context || '',
        // Evidence enriched with correlation (LINKED vs file-only) — surfaced in the
        // findings browser + reports so a runtime leak's provenance is auditable.
        evidence: bundle.evidence.map((e) => ({
          tool: e.tool,
          file: e.file_path,
          line: e.line_number,
          function: e.function_name,
          bytes_lost: e.bytes_lost,
          blocks_lost: e.blocks_lost,
          severity: e.severity,
          correlated_to_candidate: e.correlatedToCandidate ?? false,
          correlation_method: e.correlationMethod ?? 'none',
          leak_kind: e.leakKind ?? null,
          alloc_site: e.allocSite ?? null,
        })),
      };
      // Consensus voting — only present for a ConsensusVerdict (samples array).
      if (v && Array.isArray(v.samples)) {
        finding.consensus = {
          agreement: v.agreement ?? 0,
          samples: v.samples.map((s: any) => ({ verdict: s.verdict, confidence: s.confidence })),
          overridden: v.overridden ?? false,
          evidence_fusion: v.evidenceFusion ?? null,
        };
      }
      // Structured static evidence (ownership + alloc→free pairs + feasible-leak-path
      // narratives) — the static half of the judge's reasoning, for the browser.
      const se = bundle.staticEvidence;
      if (se) {
        finding.static_evidence = {
          ownership: se.ownership
            ? { role: se.ownership.role, carrier: se.ownership.ownershipCarrier, rationale: se.ownership.rationale }
            : null,
          alloc_free_pairs: (se.allocFreePairs || []).map((p) => ({
            variable: p.variable,
            alloc_line: p.allocLine,
            free_line: p.freeLine,
            status: p.status,
          })),
          feasible_leak_paths: (se.feasibleLeakPaths || []).map((fp) => ({
            narrative: (fp.narrative || '').slice(0, 280),
            leak_risk: fp.leakRisk,
            reachable: fp.reachable,
          })),
        };
      }
      return finding;
    }),
  };

  return JSON.stringify(snapshot, null, 2);
}
