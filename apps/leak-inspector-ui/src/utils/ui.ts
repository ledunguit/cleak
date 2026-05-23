import type { ScanEvent } from '@/types';

function toMs(value?: number | string): number {
  if (!value) return Date.now();
  if (typeof value === 'number') return value * 1000;
  return new Date(value).getTime();
}

export function formatClock(value?: number | string): string {
  const date = new Date(toMs(value));
  const time = date.toLocaleTimeString('en-GB', { hour12: false });
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${time}.${millis}`;
}

export function formatRelativeTime(value?: number | string): string {
  if (!value) return 'just now';
  const deltaSeconds = Math.max(0, Math.round((Date.now() - toMs(value)) / 1000));
  if (deltaSeconds < 5) return 'just now';
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function describeMode(data: Record<string, any>): string {
  const mode = data?.analysisMode || 'no_llm';
  const judge = data?.judgeSummary || {};
  if (mode === 'llm_assisted') {
    const effective = judge.effectiveMode || 'pending';
    const provider = judge.provider ? ` via ${judge.provider}` : '';
    const model = judge.model ? ` (${judge.model})` : '';
    return `Mode: llm_assisted | Orchestration: deterministic_policy | Judge: ${effective}${provider}${model}`;
  }
  return 'Mode: no_llm | Orchestration: deterministic_policy | Judge: heuristic';
}

export function describeEvent(event: ScanEvent): string[] {
  const label = (event.tool || event.phase || event.error_code || event.type || 'event').toUpperCase();
  const message = event.message || event.error || event.reason || event.subject || 'event received';
  const lines: string[] = [`[${formatClock(event.timestamp)}] ${label} | ${message}`];
  if (event.subject && event.subject !== message) lines.push(`  subject: ${event.subject}`);
  if (event.reason) lines.push(`  reason: ${event.reason}`);
  const workspacePath = event.workspacePath || event.workspace_path;
  const analysisMode = event.analysisMode || event.analysis_mode;
  const buildCommand = event.buildCommand || event.build_command;
  const dynamicRunIds = event.dynamicRunIds || event.dynamic_run_ids;
  const findingCount = event.findingCount ?? event.finding_count;
  const bundleCount = event.bundleCount ?? event.bundle_count;
  const candidateCount = event.candidateCount ?? event.candidate_count;
  const evidenceCount = event.evidenceCount ?? event.evidence_count;
  const workerPid = event.workerPid || event.worker_pid;
  if (workspacePath) lines.push(`  workspace: ${workspacePath}`);
  if (analysisMode) lines.push(`  analysisMode: ${analysisMode}`);
  if (buildCommand) lines.push(`  buildCommand: ${buildCommand}`);
  if (dynamicRunIds?.length) lines.push(`  dynamicRunIds: ${dynamicRunIds.join(', ')}`);
  if (event.status) lines.push(`  status: ${event.status}`);
  if (event.durationMs !== undefined) lines.push(`  durationMs: ${event.durationMs}`);
  if (findingCount !== undefined && findingCount !== null) lines.push(`  findings: ${findingCount}`);
  else if (bundleCount !== undefined && bundleCount !== null) lines.push(`  bundles: ${bundleCount}`);
  if (candidateCount !== undefined && candidateCount !== null) lines.push(`  candidates: ${candidateCount}`);
  if (evidenceCount !== undefined && evidenceCount !== null) lines.push(`  evidence: ${evidenceCount}`);
  if (workerPid) lines.push(`  workerPid: ${workerPid}`);
  if (event.remediation) lines.push(`  remediation: ${event.remediation}`);
  if (event.detail) {
    String(event.detail)
      .trim()
      .split('\n')
      .slice(0, 3)
      .forEach((line) => lines.push(`  detail: ${line}`));
  }
  return lines;
}

export function tagColor(status?: string): string {
  const value = status || 'idle';
  if (value === 'completed') return 'success';
  if (value === 'failed') return 'error';
  if (value === 'cancelled') return 'warning';
  return 'processing';
}
