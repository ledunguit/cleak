import type { ScanReport } from '../../types';
import { coverageText, judgeSummary, correlationText, severityBadge } from './shared';

export function toMarkdown(report: ScanReport): string {
  const lines: string[] = [];
  lines.push(`# Memory Leak Report: ${report.scanId}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push(`- Total candidates: ${report.summary.totalCandidates}`);
  lines.push(`- Confirmed leaks: ${report.summary.confirmedLeaks}`);
  lines.push(`- Likely leaks: ${report.summary.likelyLeaks}`);
  lines.push(`- False positives: ${report.summary.falsePositives}`);
  lines.push(`- Total bytes lost: ${report.summary.totalBytesLost}`);
  if ((report as any).investigationPlan?.rationale) {
    lines.push(`- Investigation strategy: ${(report as any).investigationPlan.rationale}`);
  }
  lines.push('');

  // Severity breakdown
  const critical = report.bundles.filter((b) => b.verdict?.confidence && b.verdict.confidence >= 0.8).length;
  const high = report.bundles.filter((b) => b.verdict?.confidence && b.verdict.confidence >= 0.6 && b.verdict.confidence < 0.8).length;
  const medium = report.bundles.filter((b) => b.verdict?.confidence && b.verdict.confidence >= 0.4 && b.verdict.confidence < 0.6).length;
  const low = report.bundles.filter((b) => b.verdict?.confidence && b.verdict.confidence < 0.4).length;

  lines.push(`### Severity Breakdown`);
  lines.push(`- Critical (≥80%): ${critical}`);
  lines.push(`- High (60-79%): ${high}`);
  lines.push(`- Medium (40-59%): ${medium}`);
  lines.push(`- Low (<40%): ${low}`);
  lines.push('');

  lines.push(`## Findings`);
  for (const bundle of report.bundles) {
    if (bundle.verdict) {
      const severity = severityBadge(bundle.verdict.confidence);
      lines.push(`### ${bundle.candidate.function_name} at ${bundle.candidate.file_path}:${bundle.candidate.line_number}`);
      lines.push(`- **Verdict**: ${bundle.verdict.verdict}`);
      lines.push(`- **Confidence**: ${(bundle.verdict.confidence * 100).toFixed(0)}% (${severity})`);
      lines.push(`- **Allocation type**: ${bundle.candidate.allocation_type}`);
      lines.push(`- **Dynamic coverage**: ${coverageText(bundle.dynamicCoverage)}`);
      lines.push(`- **Judge**: ${judgeSummary(bundle.verdict)}`);
      lines.push(`- ${bundle.verdict.explanation}`);
      if (bundle.verdict.repair_suggestion) {
        lines.push(`- **Suggested fix**: ${bundle.verdict.repair_suggestion}`);
      }
      const rootCause = bundle.verdict.rootCause;
      if (rootCause) {
        lines.push(`- **Root cause**: ${rootCause.patternType}`);
        lines.push(`  - Allocation site: \`${rootCause.allocationFile}:${rootCause.allocationLine}\``);
        lines.push(`  - Missing free: \`${rootCause.rootCauseFunction} @ ${rootCause.rootCauseLine}\``);
        if (rootCause.rootCauseDescription) {
          lines.push(`  - ${rootCause.rootCauseDescription}`);
        }
      }
      const repairDiff = bundle.verdict.repairDiff;
      if (repairDiff) {
        lines.push('');
        lines.push(`- **Fix diff** (\`${repairDiff.filePath}\` @ line ${repairDiff.startLine}):`);
        if (repairDiff.description) {
          lines.push(`  ${repairDiff.description}`);
        }
        lines.push('```diff');
        for (const original of repairDiff.originalLines) {
          lines.push(`- ${original}`);
        }
        for (const suggested of repairDiff.suggestedLines) {
          lines.push(`+ ${suggested}`);
        }
        lines.push('```');
      }
      if (bundle.evidence.length > 0) {
        lines.push(`- **Evidence (${bundle.evidence.length})**:`);
        for (const e of bundle.evidence) {
          const corr = correlationText(e.correlationMethod);
          lines.push(`  - ${e.tool}: ${e.function_name} (${e.bytes_lost} bytes lost) — ${corr}${e.leakKind ? `, ${e.leakKind}` : ''}`);
        }
      }
      const se = bundle.staticEvidence;
      if (se) {
        if (se.ownership) {
          lines.push(`- **Ownership**: ${se.ownership.role}${se.ownership.rationale ? ` — ${se.ownership.rationale}` : ''}`);
        }
        const paths = se.feasibleLeakPaths || [];
        if (paths.length > 0) {
          lines.push(`- **Feasible leak paths**:`);
          for (const fp of paths.slice(0, 5)) {
            lines.push(`  - ${(fp.narrative || '').slice(0, 280)}${fp.reachable === false ? ' (unreachable)' : ''}`);
          }
        }
      }
      if (bundle.candidate.context) {
        lines.push('');
        lines.push('```c');
        lines.push(bundle.candidate.context);
        lines.push('```');
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
