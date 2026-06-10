/**
 * Headless scan runner — drives the same scan controller as the TUI, but emits
 * events as JSON lines (to results/<scanId>/events.jsonl and optionally stdout)
 * and writes the report artifacts. This is the surface the experiment scripts
 * call; it produces the reproducible outputs the thesis evaluates.
 */

import { resolve, basename, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { McpClient } from '@mcpvul/agent-core';
import { AnalysisMode, DynamicMode } from '@mcpvul/common/types';
import { loadConfig, type Provider } from '../config';
import { loadEnvFiles } from '../domain/env';
import { buildPathResolver } from '../domain/pathResolver';
import { ScanEmitter, JsonlFileSink, MultiSink, type EventSink } from '../orchestrator/events';
import { runScan, type ScanResult } from '../orchestrator/scanController';
import { buildWorkflowInvestigationPhase } from '../orchestrator/workflowInvestigation';
import { scanDir, writeReports, writeScanMetrics, type ReportFormatOpt } from '../domain/reportSink';
import { computeScanMetrics } from '../domain/scanMetrics';

export interface HeadlessOptions {
  repo: string;
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  provider?: Provider;
  format: string;
  build?: string;
  fileLimit?: number;
  staticUrl?: string;
  dynamicUrl?: string;
  quiet?: boolean;
}

export interface HeadlessResult extends ScanResult {
  scanId: string;
  dir: string;
  files: string[];
}

export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  loadEnvFiles();
  const cfg = loadConfig({
    provider: opts.provider,
    ...(opts.staticUrl ? { staticUrl: opts.staticUrl } : {}),
    ...(opts.dynamicUrl ? { dynamicUrl: opts.dynamicUrl } : {}),
  });

  const repoPath = resolve(opts.repo);
  if (!existsSync(repoPath)) throw new Error(`Repository path not found: ${repoPath}`);

  const analysisMode = opts.mode === 'llm_assisted' ? AnalysisMode.LLM_ASSISTED : AnalysisMode.NO_LLM;
  const dynamicMode =
    opts.dynamic === 'aggressive'
      ? DynamicMode.AGGRESSIVE
      : opts.dynamic === 'selective'
        ? DynamicMode.SELECTIVE
        : DynamicMode.OFF;

  const scanId = makeScanId(repoPath);
  const dir = scanDir(cfg.resultsDir, scanId);

  const sinks: EventSink[] = [new JsonlFileSink(join(dir, 'events.jsonl'), !opts.quiet)];
  const emitter = new ScanEmitter(new MultiSink(sinks));

  const staticClient = new McpClient(cfg.staticUrl, 'static');
  const dynamicClient = dynamicMode !== DynamicMode.OFF ? new McpClient(cfg.dynamicUrl, 'dynamic') : undefined;
  const pathResolver = buildPathResolver({
    hostRoot: cfg.hostRoot,
    analyzerRoot: cfg.analyzerRoot,
    dynamicEnabled: dynamicMode !== DynamicMode.OFF,
    cwd: process.cwd(),
  });

  const investigation =
    analysisMode === AnalysisMode.LLM_ASSISTED ? buildWorkflowInvestigationPhase(cfg, dynamicMode) : undefined;

  const startedAt = Date.now();
  try {
    const result = await runScan(
      {
        scanId,
        repoPath,
        analysisMode,
        dynamicMode,
        fileLimit: opts.fileLimit,
        buildCommand: opts.build,
      },
      { staticClient, dynamicClient, emitter, pathResolver, investigation },
    );

    const formats = parseFormats(opts.format);
    const { files } = writeReports(
      dir,
      result.report,
      formats,
      result.investigation?.transcript as any,
      result.investigation?.stepsLog,
    );
    if (existsSync(join(dir, 'snapshot.json'))) {
      try {
        const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf-8'));
        writeScanMetrics(
          dir,
          computeScanMetrics(snap, {
            mode: opts.mode,
            dynamic: opts.dynamic,
            turns: result.investigation?.turns,
            inputTokens: result.investigation?.usage?.inputTokens,
            outputTokens: result.investigation?.usage?.outputTokens,
            durationMs: Date.now() - startedAt,
          }),
        );
      } catch {
        /* metrics best-effort */
      }
    }

    if (!opts.quiet) {
      const s = result.report.summary;
      process.stdout.write(
        `\n✓ scan ${scanId} complete — ${s.totalCandidates} candidates, ` +
          `${s.confirmedLeaks} confirmed, ${s.likelyLeaks} likely. Reports in ${dir}\n`,
      );
    }
    return { ...result, scanId, dir, files };
  } finally {
    await staticClient.close();
    await dynamicClient?.close();
  }
}

function parseFormats(spec: string): ReportFormatOpt[] {
  const allowed = new Set(['json', 'markdown', 'md', 'html', 'snapshot', 'csv']);
  return spec
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => allowed.has(s)) as ReportFormatOpt[];
}

function makeScanId(repoPath: string): string {
  const name = basename(repoPath).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.abs(hashString(repoPath + d.getTime())).toString(36).slice(0, 6);
  return `scan_${name}_${stamp}_${rand}`;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
