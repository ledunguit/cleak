/**
 * Bridges a /scan request from the TUI to the shared scan controller: wires the
 * ScanEvent stream and the raw AgentEvent stream into the store, runs the scan,
 * and writes the report artifacts. Mirrors the headless runner but renders into
 * the live store instead of stdout.
 */

import { resolve, basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { McpClient } from '@mcpvul/agent-core';
import { AnalysisMode, DynamicMode } from '@mcpvul/common/types';
import { loadConfig } from '../../config';
import { buildPathResolver } from '../../domain/pathResolver';
import { ScanEmitter, CallbackSink, JsonlFileSink, MultiSink } from '../../orchestrator/events';
import { runScan } from '../../orchestrator/scanController';
import { buildWorkflowInvestigationPhase } from '../../orchestrator/workflowInvestigation';
import { scanDir, writeReports, writeScanMetrics } from '../../domain/reportSink';
import { computeScanMetrics } from '../../domain/scanMetrics';
import { readFileSync } from 'node:fs';
import type { TuiStore } from './store';

export interface TuiScanRequest {
  repo: string;
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  staticUrl?: string;
  dynamicUrl?: string;
}

export async function runTuiScan(store: TuiStore, req: TuiScanRequest): Promise<void> {
  const cfg = loadConfig({
    provider: store.getSnapshot().provider as any,
    ...(req.staticUrl ? { staticUrl: req.staticUrl } : {}),
    ...(req.dynamicUrl ? { dynamicUrl: req.dynamicUrl } : {}),
  });

  const repoPath = resolve(req.repo);
  if (!existsSync(repoPath)) {
    store.failRun(`Repository path not found: ${repoPath}`);
    return;
  }

  const analysisMode = req.mode === 'llm_assisted' ? AnalysisMode.LLM_ASSISTED : AnalysisMode.NO_LLM;
  const dynamicMode =
    req.dynamic === 'aggressive'
      ? DynamicMode.AGGRESSIVE
      : req.dynamic === 'selective'
        ? DynamicMode.SELECTIVE
        : DynamicMode.OFF;

  const scanId = `scan_${basename(repoPath).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}_${Date.now().toString(36)}`;
  const dir = scanDir(cfg.resultsDir, scanId);
  store.beginRun(scanId, req.mode);

  const sink = new MultiSink([
    new JsonlFileSink(join(dir, 'events.jsonl'), false),
    new CallbackSink((ev) => store.applyScanEvent(ev)),
  ]);
  const emitter = new ScanEmitter(sink);

  const staticClient = new McpClient(cfg.staticUrl, 'static');
  const dynamicClient = dynamicMode !== DynamicMode.OFF ? new McpClient(cfg.dynamicUrl, 'dynamic') : undefined;
  const pathResolver = buildPathResolver({
    hostRoot: cfg.hostRoot,
    analyzerRoot: cfg.analyzerRoot,
    dynamicEnabled: dynamicMode !== DynamicMode.OFF,
    cwd: process.cwd(),
  });
  if (dynamicMode !== DynamicMode.OFF) store.addSystemMessage(`dynamic enabled · analyzer path map: ${pathResolver.describe()}`);
  const investigation =
    analysisMode === AnalysisMode.LLM_ASSISTED ? buildWorkflowInvestigationPhase(cfg, dynamicMode) : undefined;

  const abort = new AbortController();
  store.setAbortController(abort);

  const startedAt = Date.now();
  try {
    const result = await runScan(
      { scanId, repoPath, analysisMode, dynamicMode },
      {
        staticClient,
        dynamicClient,
        emitter,
        pathResolver,
        investigation,
        abortSignal: abort.signal,
        getSteering: () => store.drainSteering(),
        awaitResume: () => store.awaitResume(),
        onAgentEvent: (ev, agent) => store.applyAgentEvent(ev, agent),
        onModelActivity: (dir) => store.setIo(dir === 'send' ? 'up' : 'down'),
        requestPermission: (r) => store.requestPermission(r),
      },
    );
    writeReports(
      dir,
      result.report,
      ['json', 'markdown', 'snapshot'],
      result.investigation?.transcript as any,
      result.investigation?.stepsLog,
    );
    try {
      const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf-8'));
      writeScanMetrics(
        dir,
        computeScanMetrics(snap, {
          mode: req.mode,
          dynamic: req.dynamic,
          turns: result.investigation?.turns,
          inputTokens: result.investigation?.usage?.inputTokens,
          outputTokens: result.investigation?.usage?.outputTokens,
          durationMs: Date.now() - startedAt,
        }),
      );
    } catch {
      /* metrics are best-effort */
    }
    store.finishRun(dir, {
      candidates: result.report.summary.totalCandidates,
      confirmed: result.report.summary.confirmedLeaks,
      likely: result.report.summary.likelyLeaks,
    });
  } catch (err: any) {
    store.failRun(err?.message ?? String(err));
  } finally {
    store.setAbortController(undefined);
    await staticClient.close();
    await dynamicClient?.close();
  }
}
