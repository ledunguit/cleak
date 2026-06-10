/**
 * Persist a scan's outputs under results/<scanId>/: the requested report
 * formats, plus the full agent transcript for reproducibility. events.jsonl is
 * written incrementally during the scan by the JsonlFileSink into the same dir.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LeakReporting } from '@mcpvul/common/analysis/reporting';
import type { ScanReport } from '@mcpvul/common/types';
import type { Message } from '@mcpvul/agent-core';

const reporter = new LeakReporting();

export type ReportFormatOpt = 'json' | 'markdown' | 'md' | 'html' | 'snapshot' | 'csv';

export interface ReportArtifacts {
  dir: string;
  files: string[];
}

export function scanDir(resultsDir: string, scanId: string): string {
  const dir = join(resultsDir, scanId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write the per-scan descriptive metrics (verdict mix, confidence, cost). */
export function writeScanMetrics(dir: string, metrics: unknown): string {
  const p = join(dir, 'metrics.json');
  writeFileSync(p, JSON.stringify(metrics, null, 2));
  return p;
}

export function writeReports(
  dir: string,
  report: ScanReport & Record<string, unknown>,
  formats: ReportFormatOpt[],
  transcript?: Message[],
  stepsLog?: string,
): ReportArtifacts {
  const files: string[] = [];
  const write = (name: string, content: string) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    files.push(p);
  };

  if (formats.includes('json')) write('report.json', reporter.toJson(report));
  if (formats.includes('markdown') || formats.includes('md')) write('report.md', reporter.toMarkdown(report));
  if (formats.includes('html')) write('report.html', reporter.toHtml(report));
  if (formats.includes('snapshot')) write('snapshot.json', reporter.toSnapshot(report));
  if (formats.includes('csv')) write('report.csv', reporter.toCsv(report));
  if (transcript) write('transcript.json', JSON.stringify(transcript, null, 2));
  if (stepsLog) write('steps.md', stepsLog);

  return { dir, files };
}
