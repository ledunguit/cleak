/**
 * LeakReporting — pure ScanReport → string|Buffer renderers (JSON, Markdown,
 * HTML, Snapshot, CSV, PDF). No framework dependencies, so both the control
 * plane (via a thin @Injectable wrapper) and the TUI/headless runner share the
 * exact same output. `toSnapshot` is the canonical machine-comparable format
 * used for experiment evaluation.
 */
import {
  LeakBundle,
  ScanMetadata,
  ReportSummary,
  ScanReport,
  ToolKind,
} from '../types';

export class LeakReporting {
  buildReport(
    bundles: LeakBundle[],
    metadata: ScanMetadata,
    extras: Record<string, unknown> = {},
  ): ScanReport & Record<string, unknown> {
    const confirmed = bundles.filter(
      (b) => b.verdict?.verdict === 'confirmed_leak' || b.verdict?.verdict === 'likely_leak',
    );
    const fp = bundles.filter(
      (b) => b.verdict?.verdict === 'false_positive' || b.verdict?.verdict === 'likely_false_positive',
    );

    const toolsSet = new Set<ToolKind>();
    for (const b of bundles) {
      if (b.verdict?.tool) toolsSet.add(b.verdict.tool);
      for (const e of b.evidence) toolsSet.add(e.tool);
    }

    const totalBytes = confirmed.reduce(
      (sum, b) => sum + b.evidence.reduce((s, e) => s + e.bytes_lost, 0),
      0,
    );

    const summary: ReportSummary = {
      totalCandidates: bundles.length,
      confirmedLeaks: bundles.filter((b) => b.verdict?.verdict === 'confirmed_leak').length,
      likelyLeaks: bundles.filter((b) => b.verdict?.verdict === 'likely_leak').length,
      falsePositives: fp.length,
      totalBytesLost: totalBytes,
      toolsUsed: Array.from(toolsSet),
      durationSec: metadata.completedAt
        ? (new Date(metadata.completedAt).getTime() - new Date(metadata.startedAt).getTime()) / 1000
        : 0,
    };

    return {
      scanId: metadata.scanId,
      metadata,
      bundles,
      summary,
      ...extras,
    };
  }

  toJson(report: ScanReport): string {
    return JSON.stringify(report, null, 2);
  }

  toMarkdown(report: ScanReport): string {
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
        const severity = this.severityBadge(bundle.verdict.confidence);
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

  toHtml(report: ScanReport): string {
    const severityColor = (confidence: number): string => {
      if (confidence >= 0.8) return '#dc3545';
      if (confidence >= 0.6) return '#fd7e14';
      if (confidence >= 0.4) return '#ffc107';
      return '#6c757d';
    };

    const verdictIcon = (verdict: string): string => {
      if (verdict === 'confirmed_leak') return '🔴';
      if (verdict === 'likely_leak') return '🟠';
      if (verdict === 'uncertain') return '🟡';
      return '🟢';
    };

    const findingsRows = report.bundles
      .filter((b) => b.verdict)
      .map(
        (b) => `
      <tr class="severity-${b.verdict!.verdict}">
        <td><span class="severity-dot" style="background:${severityColor(b.verdict!.confidence)}"></span></td>
        <td>${verdictIcon(b.verdict!.verdict)} ${b.verdict!.verdict}</td>
        <td>${(b.verdict!.confidence * 100).toFixed(0)}%</td>
        <td>${escapeHtml(coverageText(b.dynamicCoverage))}</td>
        <td>${escapeHtml(judgeSummary(b.verdict))}</td>
        <td><code>${escapeHtml(b.candidate.function_name)}</code></td>
        <td><code>${escapeHtml(b.candidate.file_path)}:${b.candidate.line_number}</code></td>
        <td><code>${escapeHtml(b.candidate.allocation_type)}</code></td>
        <td><pre style="white-space:pre-wrap;margin:0;font-size:11px;line-height:1.3">${escapeHtml((b.verdict!.explanation || '').slice(0, 200))}</pre></td>
        <td>${escapeHtml(b.verdict!.repair_suggestion || '')}</td>
      </tr>`,
      )
      .join('');

    const criticalCount = report.bundles.filter((b) => b.verdict?.confidence && b.verdict.confidence >= 0.8).length;
    const highCount = report.bundles.filter((b) => b.verdict?.confidence && b.verdict.confidence >= 0.6 && b.verdict.confidence < 0.8).length;
    const mediumCount = report.bundles.filter((b) => b.verdict?.confidence && b.verdict.confidence >= 0.4 && b.verdict.confidence < 0.6).length;

    const detailSections = report.bundles
      .filter((b) => b.verdict && b.verdict.verdict !== 'false_positive' && b.verdict.verdict !== 'likely_false_positive')
      .slice(0, 30)
      .map(
        (b, idx) => `
      <div class="finding-detail">
        <h3 onclick="toggleDetail(${idx})" style="cursor:pointer;user-select:none">
          <span class="finding-toggle" id="toggle-${idx}">▶</span>
          #${idx + 1}: ${escapeHtml(b.candidate.function_name)} — ${b.verdict!.verdict}
          <span class="confidence-badge" style="background:${severityColor(b.verdict!.confidence)}">
            ${(b.verdict!.confidence * 100).toFixed(0)}%
          </span>
        </h3>
        <div class="finding-body" id="detail-${idx}" style="display:none">
          <table class="finding-meta">
            <tr><td>Function</td><td><code>${escapeHtml(b.candidate.function_name)}</code></td></tr>
            <tr><td>File</td><td><code>${escapeHtml(b.candidate.file_path)}:${b.candidate.line_number}</code></td></tr>
            <tr><td>Allocation</td><td><code>${escapeHtml(b.candidate.allocation_type)}</code> at line ${b.candidate.line_number}</td></tr>
            <tr><td>Confidence</td><td>${(b.verdict!.confidence * 100).toFixed(0)}%</td></tr>
            <tr><td>Dynamic coverage</td><td>${escapeHtml(coverageText(b.dynamicCoverage))}</td></tr>
            <tr><td>Judge</td><td>${escapeHtml(judgeSummary(b.verdict))}</td></tr>
          </table>
          <div class="explanation">
            <strong>Explanation:</strong>
            <p>${escapeHtml(b.verdict!.explanation || 'No explanation provided.')}</p>
          </div>
          ${b.verdict!.repair_suggestion ? `
          <div class="suggestion">
            <strong>Suggested Fix:</strong>
            <pre style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #dee2e6">${escapeHtml(b.verdict!.repair_suggestion)}</pre>
          </div>` : ''}
          ${b.verdict!.rootCause ? `
          <div class="root-cause">
            <strong>Root Cause:</strong>
            <table class="finding-meta">
              <tr><td>Pattern</td><td><code>${escapeHtml(String(b.verdict!.rootCause.patternType))}</code></td></tr>
              <tr><td>Allocation site</td><td><code>${escapeHtml(b.verdict!.rootCause.allocationFile)}:${b.verdict!.rootCause.allocationLine}</code></td></tr>
              <tr><td>Missing free</td><td><code>${escapeHtml(b.verdict!.rootCause.rootCauseFunction)} @ ${b.verdict!.rootCause.rootCauseLine}</code></td></tr>
            </table>
            ${b.verdict!.rootCause.rootCauseDescription ? `<p>${escapeHtml(b.verdict!.rootCause.rootCauseDescription)}</p>` : ''}
          </div>` : ''}
          ${b.verdict!.repairDiff ? `
          <div class="repair-diff">
            <strong>Fix Diff:</strong>
            <p style="font-size:12px;color:#555;margin:4px 0"><code>${escapeHtml(b.verdict!.repairDiff.filePath)}</code> @ line ${b.verdict!.repairDiff.startLine}${b.verdict!.repairDiff.description ? ` — ${escapeHtml(b.verdict!.repairDiff.description)}` : ''}</p>
            <pre class="diff-block" style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #dee2e6;overflow-x:auto">${
              b.verdict!.repairDiff.originalLines
                .map((line) => `<span class="diff-del">- ${escapeHtml(line)}</span>`)
                .concat(
                  b.verdict!.repairDiff.suggestedLines.map((line) => `<span class="diff-add">+ ${escapeHtml(line)}</span>`),
                )
                .join('\n')
            }</pre>
          </div>` : ''}
          ${b.evidence.length ? `
          <div class="runtime-evidence">
            <strong>Runtime Evidence:</strong>
            <ul style="margin:4px 0 0 18px;font-size:13px">
              ${b.evidence
                .slice(0, 10)
                .map(
                  (e) =>
                    `<li><code>${escapeHtml(e.tool)}</code> · ${e.bytes_lost} bytes · ${correlationText(e.correlationMethod)}${e.leakKind ? ` · ${escapeHtml(String(e.leakKind))}` : ''}${e.allocSite ? ` · <code>${escapeHtml(e.allocSite.file)}:${e.allocSite.line}</code>` : ''}</li>`,
                )
                .join('')}
            </ul>
          </div>` : ''}
          ${b.staticEvidence ? `
          <div class="static-evidence">
            <strong>Static Analysis:</strong>
            ${b.staticEvidence.ownership ? `<p style="font-size:13px;margin:4px 0">Ownership: <code>${escapeHtml(b.staticEvidence.ownership.role)}</code>${b.staticEvidence.ownership.rationale ? ` — ${escapeHtml(b.staticEvidence.ownership.rationale)}` : ''}</p>` : ''}
            ${(b.staticEvidence.feasibleLeakPaths || []).length ? `<ul style="margin:4px 0 0 18px;font-size:13px">${(b.staticEvidence.feasibleLeakPaths || [])
              .slice(0, 5)
              .map((fp) => `<li>${escapeHtml((fp.narrative || '').slice(0, 280))}${fp.reachable === false ? ' (unreachable)' : ''}</li>`)
              .join('')}</ul>` : ''}
          </div>` : ''}
          ${b.candidate.context ? `
          <div class="code-snippet">
            <strong>Code Snippet:</strong>
            <pre style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #dee2e6;overflow-x:auto"><code>${escapeHtml(b.candidate.context)}</code></pre>
          </div>` : ''}
        </div>
      </div>`,
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Memory Leak Report — ${report.scanId}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #1a1a2e; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: white; padding: 32px; border-radius: 12px; margin-bottom: 24px; }
    .header h1 { font-size: 24px; margin-bottom: 8px; }
    .header .meta { font-size: 13px; color: #a0a0c0; }
    .header .meta span { margin-right: 20px; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .summary-card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; }
    .summary-card .number { font-size: 32px; font-weight: 700; }
    .summary-card .label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-card.danger .number { color: #dc3545; }
    .summary-card.warning .number { color: #fd7e14; }
    .summary-card.info .number { color: #0d6efd; }
    .summary-card.success .number { color: #198754; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 24px; }
    th { background: #f8f9fa; padding: 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; text-align: left; border-bottom: 2px solid #dee2e6; }
    td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 13px; vertical-align: top; }
    tr:hover { background: #f8f9ff; }
    .severity-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .confidence-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; color: white; font-size: 11px; font-weight: 600; margin-left: 8px; }
    .finding-detail { background: white; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 12px; overflow: hidden; }
    .finding-detail h3 { padding: 14px 20px; margin: 0; font-size: 15px; background: #fafafa; border-bottom: 1px solid #eee; }
    .finding-body { padding: 20px; }
    .finding-meta { width: 100%; margin-bottom: 16px; }
    .finding-meta td { padding: 6px 12px; border: none; font-size: 13px; }
    .finding-meta td:first-child { font-weight: 600; color: #555; width: 120px; }
    .explanation, .suggestion, .code-snippet, .root-cause, .repair-diff { margin-bottom: 16px; }
    .diff-block { font-family: 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 12px; line-height: 1.4; }
    .diff-block .diff-del { display: block; color: #b02a37; background: #fbeaec; }
    .diff-block .diff-add { display: block; color: #146c43; background: #e8f5ec; }
    .finding-toggle { margin-right: 8px; font-size: 12px; }
    .severity-confirmed_leak { border-left: 4px solid #dc3545; }
    .severity-likely_leak { border-left: 4px solid #fd7e14; }
    .severity-uncertain { border-left: 4px solid #ffc107; }
    .chart-bar { display: inline-block; height: 20px; border-radius: 4px; margin-right: 2px; }
    @media print {
      body { background: white; }
      .header { background: #1a1a2e !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .summary-card { break-inside: avoid; }
    }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🛡️ Memory Leak Report</h1>
    <p style="margin:4px 0 12px;color:#a0a0c0">Automated C/C++ Memory Leak Detection</p>
    <div class="meta">
      <span>📋 Scan ID: ${report.scanId}</span>
      <span>📁 Workspace: ${escapeHtml(report.metadata.workspacePath)}</span>
      <span>⏱ Duration: ${report.summary.durationSec.toFixed(1)}s</span>
      <span>🔧 Tools: ${(report.summary.toolsUsed || ['n/a']).join(', ')}</span>
    </div>
  </div>

  <div class="summary-grid">
    <div class="summary-card danger">
      <div class="number">${report.summary.totalCandidates}</div>
      <div class="label">Total Candidates</div>
    </div>
    <div class="summary-card danger">
      <div class="number">${report.summary.confirmedLeaks}</div>
      <div class="label">Confirmed Leaks</div>
    </div>
    <div class="summary-card warning">
      <div class="number">${report.summary.likelyLeaks}</div>
      <div class="label">Likely Leaks</div>
    </div>
    <div class="summary-card info">
      <div class="number">${report.summary.falsePositives}</div>
      <div class="label">False Positives</div>
    </div>
    <div class="summary-card success">
      <div class="number">${report.summary.totalBytesLost}</div>
      <div class="label">Bytes Lost</div>
    </div>
  </div>

  <div style="background:white;border-radius:10px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,0.08);margin-bottom:24px">
    <h2 style="font-size:16px;margin-bottom:12px">Severity Distribution</h2>
    <div style="display:flex;gap:4px;height:24px;border-radius:4px;overflow:hidden;margin-bottom:8px">
      ${criticalCount > 0 ? `<div class="chart-bar" style="background:#dc3545;width:${(criticalCount / Math.max(1, report.summary.totalCandidates) * 100).toFixed(1)}%"></div>` : ''}
      ${highCount > 0 ? `<div class="chart-bar" style="background:#fd7e14;width:${(highCount / Math.max(1, report.summary.totalCandidates) * 100).toFixed(1)}%"></div>` : ''}
      ${mediumCount > 0 ? `<div class="chart-bar" style="background:#ffc107;width:${(mediumCount / Math.max(1, report.summary.totalCandidates) * 100).toFixed(1)}%"></div>` : ''}
    </div>
    <div style="display:flex;gap:20px;font-size:12px;color:#666">
      <span>🔴 Critical: ${criticalCount}</span>
      <span>🟠 High: ${highCount}</span>
      <span>🟡 Medium: ${mediumCount}</span>
      <span>⚪ Low: ${report.summary.totalCandidates - criticalCount - highCount - mediumCount}</span>
    </div>
  </div>

  <h2 style="font-size:18px;margin-bottom:12px">Findings Table</h2>
  <table>
    <thead>
      <tr>
        <th style="width:20px"></th>
        <th>Verdict</th>
        <th>Conf.</th>
        <th>Coverage</th>
        <th>Judge</th>
        <th>Function</th>
        <th>Location</th>
        <th>Alloc</th>
        <th>Explanation</th>
        <th>Suggested Fix</th>
      </tr>
    </thead>
    <tbody>
      ${findingsRows || '<tr><td colspan="10" style="text-align:center;color:#999">No findings to display</td></tr>'}
    </tbody>
  </table>

  <h2 style="font-size:18px;margin-bottom:12px">Detailed Findings</h2>
  ${detailSections || '<p style="color:#666">No detailed findings available.</p>'}

  <div style="text-align:center;margin-top:32px;padding:20px;color:#999;font-size:12px">
    Generated by Memory Leak Scanner — ${new Date().toISOString()}
  </div>
</div>
<script>
function toggleDetail(idx) {
  const body = document.getElementById('detail-' + idx);
  const toggle = document.getElementById('toggle-' + idx);
  if (body.style.display === 'none') {
    body.style.display = 'block';
    toggle.textContent = '▼';
  } else {
    body.style.display = 'none';
    toggle.textContent = '▶';
  }
}
</script>
</body>
</html>`;
  }

  toSnapshot(report: ScanReport & Record<string, any>): string {
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

  toCsv(report: ScanReport): string {
    const headers = 'id,function,file,line,allocation_type,verdict,confidence,explanation,repair_suggestion\n';
    const rows = report.bundles
      .filter((b) => b.verdict)
      .map((b) =>
        [
          b.bundleId,
          escapeCsv(b.candidate.function_name),
          escapeCsv(b.candidate.file_path),
          b.candidate.line_number,
          escapeCsv(b.candidate.allocation_type),
          b.verdict!.verdict,
          b.verdict!.confidence.toFixed(2),
          escapeCsv((b.verdict!.explanation || '').slice(0, 200)),
          escapeCsv((b.verdict!.repair_suggestion || '').slice(0, 200)),
        ].join(','),
      )
      .join('\n');
    return headers + rows;
  }

  toPdf(report: ScanReport & Record<string, any>): Buffer {
    // Try to use pdfkit if available
    try {
      return this.renderPdfWithPdfkit(report);
    } catch {
      // Fallback to simple text-based PDF
      return this.renderSimplePdf(report);
    }
  }

  private renderPdfWithPdfkit(report: ScanReport & Record<string, any>): Buffer {
    let PDFDocument: any = null;
    try { PDFDocument = require('pdfkit'); } catch { /* pdfkit not available */ }
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    // Title
    doc.fontSize(22).font('Helvetica-Bold').text('Memory Leak Report', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Scan ID: ${report.scanId}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#666').text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
    doc.moveDown(1);

    // Summary
    doc.fillColor('#000').fontSize(14).font('Helvetica-Bold').text('Summary');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Total Candidates: ${report.summary.totalCandidates}`);
    doc.text(`Confirmed Leaks: ${report.summary.confirmedLeaks}`);
    doc.text(`Likely Leaks: ${report.summary.likelyLeaks}`);
    doc.text(`False Positives: ${report.summary.falsePositives}`);
    doc.text(`Total Bytes Lost: ${report.summary.totalBytesLost}`);
    doc.text(`Duration: ${report.summary.durationSec.toFixed(1)}s`);
    doc.text(`Tools: ${(report.summary.toolsUsed || ['n/a']).join(', ')}`);
    doc.moveDown(1);

    // Findings
    doc.fontSize(14).font('Helvetica-Bold').text('Findings');
    doc.moveDown(0.3);

    const findings = report.bundles.filter((b: LeakBundle) => b.verdict && b.verdict.verdict !== 'false_positive');
    for (let i = 0; i < Math.min(findings.length, 50); i++) {
      const b = findings[i];
      const v = b.verdict!;
      const conf = (v.confidence * 100).toFixed(0);

      // Check if we need a new page
      if (PDFDocument && doc.y > 650) doc.addPage();

      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a2e')
        .text(`${i + 1}. ${b.candidate.function_name} — ${v.verdict} (${conf}%)`);
      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text(`File: ${b.candidate.file_path}:${b.candidate.line_number}`);
      doc.fontSize(9).fillColor('#555')
        .text(`Allocation: ${b.candidate.allocation_type}`);
      doc.fontSize(8).fillColor('#444')
        .text(`${v.explanation || ''}`);
      if (v.repair_suggestion) {
        doc.fontSize(8).fillColor('#0066cc')
          .text(`Fix: ${v.repair_suggestion}`);
      }
      doc.moveDown(0.5);
    }

    doc.end();
    return Buffer.concat(chunks);
  }

  private renderSimplePdf(report: ScanReport & Record<string, any>): Buffer {
    const findings = report.bundles.filter((b: LeakBundle) => b.verdict && b.verdict.verdict !== 'false_positive');
    const lines = [
      `Memory Leak Report: ${report.scanId}`,
      '',
      `Workspace: ${report.metadata.sourceWorkspacePath || report.metadata.workspacePath}`,
      `Status: ${report.metadata.status || 'completed'}`,
      `Confirmed leaks: ${report.summary.confirmedLeaks}`,
      `Likely leaks: ${report.summary.likelyLeaks}`,
      `False positives: ${report.summary.falsePositives}`,
      `Total bytes lost: ${report.summary.totalBytesLost}`,
      `Tools: ${(report.summary.toolsUsed || []).join(', ') || 'n/a'}`,
      `Duration: ${report.summary.durationSec.toFixed(1)}s`,
      '',
      ...findings.slice(0, 50).flatMap((b: LeakBundle, index: number) => [
        `${index + 1}. ${b.candidate.file_path}:${b.candidate.line_number} ${b.candidate.function_name}`,
        `   Verdict: ${b.verdict?.verdict || 'pending'} (${Math.round((b.verdict?.confidence || 0) * 100)}%)`,
        `   Why: ${(b.verdict?.explanation || 'No explanation').replace(/[()]/g, '').replace(/[\x00-\x1F]/g, ' ')}`,
        `   Fix: ${(b.verdict?.repair_suggestion || 'n/a').replace(/[()]/g, '').replace(/[\x00-\x1F]/g, ' ')}`,
        '',
      ]),
    ];

    const escapedLines = lines.map((line) => {
      let safe = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      safe = safe.replace(/[^\x20-\x7E\n\r]/g, '?');
      return safe;
    });

    const content = [
      'BT',
      '/F1 9 Tf',
      '50 760 Td',
      '10 TL',
      ...escapedLines.map((line, index) => `${index === 0 ? '' : 'T* '}(${line}) Tj`.trim()),
      'ET',
    ].join('\n');

    const objects = [
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
      '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj',
      `5 0 obj << /Length ${Buffer.byteLength(content, 'utf8')} >> stream\n${content}\nendstream endobj`,
    ];

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const object of objects) {
      offsets.push(Buffer.byteLength(pdf, 'utf8'));
      pdf += `${object}\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf, 'utf8');
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    for (let i = 1; i < offsets.length; i++) {
      pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(pdf, 'utf8');
  }

  private severityBadge(confidence: number): string {
    if (confidence >= 0.8) return 'Critical';
    if (confidence >= 0.6) return 'High';
    if (confidence >= 0.4) return 'Medium';
    return 'Low';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCsv(value: string | number): string {
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Shared verdict-provenance helpers (markdown + html), mirroring the TUI card ──

/** One line of judge provenance: the deciding tool plus, for a consensus verdict,
 *  its agreement %, how many samples matched the final verdict, and any override. */
function judgeSummary(v: any): string {
  if (!v) return 'unknown';
  const tool = v.tool || 'unknown';
  if (Array.isArray(v.samples) && v.samples.length) {
    const total = v.samples.length;
    const agree = v.samples.filter((s: any) => s.verdict === v.verdict).length;
    return `${tool} (agreement ${((v.agreement ?? 0) * 100).toFixed(0)}%, ${agree}/${total} samples${v.overridden ? ', overridden' : ''})`;
  }
  return tool;
}

/** Human label for how a runtime leak correlated to its candidate. */
function correlationText(method?: string): string {
  if (method === 'file_line_exact' || method === 'file_line_near' || method === 'function_match') return 'LINKED';
  if (method === 'file_only') return 'file-only';
  return 'unlinked';
}

const COVERAGE_TEXT: Record<string, string> = {
  exercised_leak: 'exercised — leak observed',
  exercised_clean: 'exercised — clean',
  not_exercised: 'not exercised',
  dynamic_off: 'dynamic off',
};
/** Honest dynamic-coverage label (what the runtime stage actually established). */
function coverageText(cov?: string): string {
  return COVERAGE_TEXT[cov || 'dynamic_off'] || cov || 'dynamic off';
}
