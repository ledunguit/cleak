import type { ScanReport } from '../../types';
import { escapeHtml, coverageText, judgeSummary, correlationText, severityColor, verdictIcon } from './shared';
import { HTML_STYLES } from './html-styles';

function buildFindingsRows(report: ScanReport, sc: (c: number) => string, vi: (v: string) => string): string {
  return report.bundles
    .filter((b) => b.verdict)
    .map((b) => `
      <tr class="severity-${b.verdict!.verdict}">
        <td><span class="severity-dot" style="background:${sc(b.verdict!.confidence)}"></span></td>
        <td>${vi(b.verdict!.verdict)} ${b.verdict!.verdict}</td>
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
}

function buildDetailSections(report: ScanReport, sc: (c: number) => string): string {
  return report.bundles
    .filter((b) => b.verdict && b.verdict.verdict !== 'false_positive' && b.verdict.verdict !== 'likely_false_positive')
    .slice(0, 30)
    .map((b, idx) => {
      const v = b.verdict!;
      const rootCauseBlock = v.rootCause ? `
          <div class="root-cause">
            <strong>Root Cause:</strong>
            <table class="finding-meta">
              <tr><td>Pattern</td><td><code>${escapeHtml(String(v.rootCause.patternType))}</code></td></tr>
              <tr><td>Allocation site</td><td><code>${escapeHtml(v.rootCause.allocationFile)}:${v.rootCause.allocationLine}</code></td></tr>
              <tr><td>Missing free</td><td><code>${escapeHtml(v.rootCause.rootCauseFunction)} @ ${v.rootCause.rootCauseLine}</code></td></tr>
            </table>
            ${v.rootCause.rootCauseDescription ? `<p>${escapeHtml(v.rootCause.rootCauseDescription)}</p>` : ''}
          </div>` : '';
      const repairDiffBlock = v.repairDiff ? `
          <div class="repair-diff">
            <strong>Fix Diff:</strong>
            <p style="font-size:12px;color:#555;margin:4px 0"><code>${escapeHtml(v.repairDiff.filePath)}</code> @ line ${v.repairDiff.startLine}${v.repairDiff.description ? ` — ${escapeHtml(v.repairDiff.description)}` : ''}</p>
            <pre class="diff-block" style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #dee2e6;overflow-x:auto">${
              v.repairDiff.originalLines.map((l) => `<span class="diff-del">- ${escapeHtml(l)}</span>`)
                .concat(v.repairDiff.suggestedLines.map((l) => `<span class="diff-add">+ ${escapeHtml(l)}</span>`))
                .join('\n')
            }</pre>
          </div>` : '';
      const evidenceBlock = b.evidence.length ? `
          <div class="runtime-evidence">
            <strong>Runtime Evidence:</strong>
            <ul style="margin:4px 0 0 18px;font-size:13px">
              ${b.evidence.slice(0, 10).map((e) =>
                `<li><code>${escapeHtml(e.tool)}</code> · ${e.bytes_lost} bytes · ${correlationText(e.correlationMethod)}${e.leakKind ? ` · ${escapeHtml(String(e.leakKind))}` : ''}${e.allocSite ? ` · <code>${escapeHtml(e.allocSite.file)}:${e.allocSite.line}</code>` : ''}</li>`,
              ).join('')}
            </ul>
          </div>` : '';
      const staticBlock = b.staticEvidence ? `
          <div class="static-evidence">
            <strong>Static Analysis:</strong>
            ${b.staticEvidence.ownership ? `<p style="font-size:13px;margin:4px 0">Ownership: <code>${escapeHtml(b.staticEvidence.ownership.role)}</code>${b.staticEvidence.ownership.rationale ? ` — ${escapeHtml(b.staticEvidence.ownership.rationale)}` : ''}</p>` : ''}
            ${(b.staticEvidence.feasibleLeakPaths || []).length ? `<ul style="margin:4px 0 0 18px;font-size:13px">${(b.staticEvidence.feasibleLeakPaths || []).slice(0, 5).map((fp) => `<li>${escapeHtml((fp.narrative || '').slice(0, 280))}${fp.reachable === false ? ' (unreachable)' : ''}</li>`).join('')}</ul>` : ''}
          </div>` : '';
      return `
      <div class="finding-detail">
        <h3 onclick="toggleDetail(${idx})" style="cursor:pointer;user-select:none">
          <span class="finding-toggle" id="toggle-${idx}">▶</span>
          #${idx + 1}: ${escapeHtml(b.candidate.function_name)} — ${v.verdict}
          <span class="confidence-badge" style="background:${sc(v.confidence)}">${(v.confidence * 100).toFixed(0)}%</span>
        </h3>
        <div class="finding-body" id="detail-${idx}" style="display:none">
          <table class="finding-meta">
            <tr><td>Function</td><td><code>${escapeHtml(b.candidate.function_name)}</code></td></tr>
            <tr><td>File</td><td><code>${escapeHtml(b.candidate.file_path)}:${b.candidate.line_number}</code></td></tr>
            <tr><td>Allocation</td><td><code>${escapeHtml(b.candidate.allocation_type)}</code> at line ${b.candidate.line_number}</td></tr>
            <tr><td>Confidence</td><td>${(v.confidence * 100).toFixed(0)}%</td></tr>
            <tr><td>Dynamic coverage</td><td>${escapeHtml(coverageText(b.dynamicCoverage))}</td></tr>
            <tr><td>Judge</td><td>${escapeHtml(judgeSummary(v))}</td></tr>
          </table>
          <div class="explanation"><strong>Explanation:</strong><p>${escapeHtml(v.explanation || 'No explanation provided.')}</p></div>
          ${v.repair_suggestion ? `<div class="suggestion"><strong>Suggested Fix:</strong><pre style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #dee2e6">${escapeHtml(v.repair_suggestion)}</pre></div>` : ''}
          ${rootCauseBlock}${repairDiffBlock}${evidenceBlock}${staticBlock}
          ${b.candidate.context ? `<div class="code-snippet"><strong>Code Snippet:</strong><pre style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #dee2e6;overflow-x:auto"><code>${escapeHtml(b.candidate.context)}</code></pre></div>` : ''}
        </div>
      </div>`;
    })
    .join('');
}

export function toHtml(report: ScanReport): string {
  const findingsRows = buildFindingsRows(report, severityColor, verdictIcon);
  const detailSections = buildDetailSections(report, severityColor);

  const criticalCount = report.bundles.filter((b) => b.verdict?.confidence && b.verdict.confidence >= 0.8).length;
  const highCount = report.bundles.filter((b) => b.verdict?.confidence && b.verdict.confidence >= 0.6 && b.verdict.confidence < 0.8).length;
  const mediumCount = report.bundles.filter((b) => b.verdict?.confidence && b.verdict.confidence >= 0.4 && b.verdict.confidence < 0.6).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Memory Leak Report — ${report.scanId}</title>
  <style>${HTML_STYLES}</style>
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
    <div class="summary-card danger"><div class="number">${report.summary.totalCandidates}</div><div class="label">Total Candidates</div></div>
    <div class="summary-card danger"><div class="number">${report.summary.confirmedLeaks}</div><div class="label">Confirmed Leaks</div></div>
    <div class="summary-card warning"><div class="number">${report.summary.likelyLeaks}</div><div class="label">Likely Leaks</div></div>
    <div class="summary-card info"><div class="number">${report.summary.falsePositives}</div><div class="label">False Positives</div></div>
    <div class="summary-card success"><div class="number">${report.summary.totalBytesLost}</div><div class="label">Bytes Lost</div></div>
  </div>
  <div style="background:white;border-radius:10px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,0.08);margin-bottom:24px">
    <h2 style="font-size:16px;margin-bottom:12px">Severity Distribution</h2>
    <div style="display:flex;gap:4px;height:24px;border-radius:4px;overflow:hidden;margin-bottom:8px">
      ${criticalCount > 0 ? `<div class="chart-bar" style="background:#dc3545;width:${(criticalCount / Math.max(1, report.summary.totalCandidates) * 100).toFixed(1)}%"></div>` : ''}
      ${highCount > 0 ? `<div class="chart-bar" style="background:#fd7e14;width:${(highCount / Math.max(1, report.summary.totalCandidates) * 100).toFixed(1)}%"></div>` : ''}
      ${mediumCount > 0 ? `<div class="chart-bar" style="background:#ffc107;width:${(mediumCount / Math.max(1, report.summary.totalCandidates) * 100).toFixed(1)}%"></div>` : ''}
    </div>
    <div style="display:flex;gap:20px;font-size:12px;color:#666">
      <span>🔴 Critical: ${criticalCount}</span><span>🟠 High: ${highCount}</span>
      <span>🟡 Medium: ${mediumCount}</span><span>⚪ Low: ${report.summary.totalCandidates - criticalCount - highCount - mediumCount}</span>
    </div>
  </div>
  <h2 style="font-size:18px;margin-bottom:12px">Findings Table</h2>
  <table><thead><tr>
    <th style="width:20px"></th><th>Verdict</th><th>Conf.</th><th>Coverage</th><th>Judge</th>
    <th>Function</th><th>Location</th><th>Alloc</th><th>Explanation</th><th>Suggested Fix</th>
  </tr></thead><tbody>
    ${findingsRows || '<tr><td colspan="10" style="text-align:center;color:#999">No findings to display</td></tr>'}
  </tbody></table>
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
  if (body.style.display === 'none') { body.style.display = 'block'; toggle.textContent = '▼'; }
  else { body.style.display = 'none'; toggle.textContent = '▶'; }
}
</script>
</body>
</html>`;
}
