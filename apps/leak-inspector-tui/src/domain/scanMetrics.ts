/**
 * Per-scan metrics derived from a scan's snapshot + runtime context, written as
 * results/<scanId>/metrics.json and rendered by the TUI `/metrics` command.
 * These are the descriptive numbers for a single run (verdict mix, confidence,
 * root-cause distribution, token/latency cost) — distinct from the benchmark
 * classification metrics (Precision/Recall/F1) which need ground truth.
 */

interface SnapshotLike {
  scan_id?: string;
  finding_count?: number;
  confirmed_leak_count?: number;
  likely_leak_count?: number;
  evidence_count?: number;
  tools_used?: string[];
  findings?: Array<{
    verdict?: string;
    verdict_tool?: string;
    confidence?: number;
    root_cause?: { patternType?: string } | null;
    evidence?: unknown[];
  }>;
}

export interface ScanMetricsContext {
  mode: string;
  dynamic: string;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

export interface ScanMetrics {
  scan_id?: string;
  generated_at: string;
  mode: string;
  dynamic: string;
  candidates: number;
  confirmed: number;
  likely: number;
  verdicts: Record<string, number>;
  confidence: { min: number; mean: number; max: number };
  root_cause_counts: Record<string, number>;
  verdict_tool_counts: Record<string, number>;
  evidence_count: number;
  tools_used: string[];
  turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  duration_ms?: number;
}

function tally(into: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  into[key] = (into[key] ?? 0) + 1;
}

export function computeScanMetrics(snapshot: SnapshotLike, ctx: ScanMetricsContext): ScanMetrics {
  const findings = snapshot.findings ?? [];
  const verdicts: Record<string, number> = {};
  const rootCauses: Record<string, number> = {};
  const verdictTools: Record<string, number> = {};
  const confidences: number[] = [];
  for (const f of findings) {
    tally(verdicts, f.verdict ?? 'pending');
    tally(rootCauses, f.root_cause?.patternType);
    tally(verdictTools, f.verdict_tool);
    if (typeof f.confidence === 'number') confidences.push(f.confidence);
  }
  const confidence =
    confidences.length === 0
      ? { min: 0, mean: 0, max: 0 }
      : {
          min: Math.min(...confidences),
          max: Math.max(...confidences),
          mean: confidences.reduce((a, b) => a + b, 0) / confidences.length,
        };
  const input = ctx.inputTokens ?? 0;
  const output = ctx.outputTokens ?? 0;
  return {
    scan_id: snapshot.scan_id,
    generated_at: new Date().toISOString(),
    mode: ctx.mode,
    dynamic: ctx.dynamic,
    candidates: snapshot.finding_count ?? findings.length,
    confirmed: snapshot.confirmed_leak_count ?? verdicts['confirmed_leak'] ?? 0,
    likely: snapshot.likely_leak_count ?? verdicts['likely_leak'] ?? 0,
    verdicts,
    confidence,
    root_cause_counts: rootCauses,
    verdict_tool_counts: verdictTools,
    evidence_count: snapshot.evidence_count ?? findings.reduce((a, f) => a + (f.evidence?.length ?? 0), 0),
    tools_used: snapshot.tools_used ?? [],
    turns: ctx.turns,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    duration_ms: ctx.durationMs,
  };
}
