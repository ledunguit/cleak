import { Injectable } from '@nestjs/common';
import {
  LeakBundle,
  ScanMetadata,
  ReportSummary,
  ScanReport,
  ToolKind,
} from '@mcpvul/common';

@Injectable()
export class ReportingService {
  buildReport(
    bundles: LeakBundle[],
    metadata: ScanMetadata,
  ): ScanReport {
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
    lines.push('');
    lines.push(`## Findings`);
    for (const bundle of report.bundles) {
      if (bundle.verdict) {
        lines.push(`### ${bundle.candidate.function_name} at ${bundle.candidate.file_path}:${bundle.candidate.line_number}`);
        lines.push(`- Verdict: ${bundle.verdict.verdict}`);
        lines.push(`- Confidence: ${(bundle.verdict.confidence * 100).toFixed(0)}%`);
        lines.push(`- ${bundle.verdict.explanation}`);
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  toHtml(report: ScanReport): string {
    const rows = report.bundles
      .map(
        (b) => `
      <tr>
        <td>${b.candidate.function_name}</td>
        <td>${b.candidate.file_path}:${b.candidate.line_number}</td>
        <td>${b.verdict?.verdict || 'pending'}</td>
        <td>${b.verdict ? `${(b.verdict.confidence * 100).toFixed(0)}%` : '-'}</td>
      </tr>`,
      )
      .join('');

    return `<!DOCTYPE html>
<html><head><title>Memory Leak Report</title>
<style>body{font-family:sans-serif;} table{border-collapse:collapse;width:100%} th,td{border:1px solid #ddd;padding:8px} th{background:#f4f4f4}</style>
</head><body>
<h1>Memory Leak Report</h1>
<h2>Summary</h2>
<ul>
  <li>Total candidates: ${report.summary.totalCandidates}</li>
  <li>Confirmed leaks: ${report.summary.confirmedLeaks}</li>
  <li>Likely leaks: ${report.summary.likelyLeaks}</li>
  <li>False positives: ${report.summary.falsePositives}</li>
  <li>Total bytes lost: ${report.summary.totalBytesLost}</li>
</ul>
<h2>Findings</h2>
<table><thead><tr><th>Function</th><th>Location</th><th>Verdict</th><th>Confidence</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
  }
}
