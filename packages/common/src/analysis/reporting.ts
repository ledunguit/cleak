/**
 * LeakReporting — pure ScanReport → string|Buffer renderers (JSON, Markdown,
 * HTML, Snapshot, CSV, PDF). No framework dependencies, so both the control
 * plane (via a thin @Injectable wrapper) and the TUI/headless runner share the
 * exact same output. `toSnapshot` is the canonical machine-comparable format
 * used for experiment evaluation.
 *
 * Each renderer lives in its own file under ./reporting/.
 */
import {
  LeakBundle,
  ScanMetadata,
  ReportSummary,
  ScanReport,
  ToolKind,
} from '../types';

import { toJson } from './reporting/report-json';
import { toMarkdown } from './reporting/report-markdown';
import { toHtml } from './reporting/report-html';
import { toSnapshot } from './reporting/report-snapshot';
import { toCsv } from './reporting/report-csv';
import { toPdf } from './reporting/report-pdf';

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
    return toJson(report);
  }

  toMarkdown(report: ScanReport): string {
    return toMarkdown(report);
  }

  toHtml(report: ScanReport): string {
    return toHtml(report);
  }

  toSnapshot(report: ScanReport & Record<string, any>): string {
    return toSnapshot(report);
  }

  toCsv(report: ScanReport): string {
    return toCsv(report);
  }

  toPdf(report: ScanReport & Record<string, any>): Buffer {
    return toPdf(report);
  }
}
