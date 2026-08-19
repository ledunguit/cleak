#!/usr/bin/env -S pnpm exec tsx
/**
 * Report full metrics for a baseline-sweep (or single eval) output directory —
 * finished baselines get the exact `baseline-sweep.md` table, baselines still
 * mid-run get a live per-run progress line (case count, status breakdown, judge
 * llm/heuristic ratio, FP/KLOC so far). No live run required; safe to run
 * against a directory another process is still writing to (e.g. over SSH mid-sweep).
 *
 * Usage:
 *   pnpm exec tsx evaluation/inspect.ts <sweepOutDir> [--baselines-dir <dir>] [--baseline B1,B6b]
 *
 * `<sweepOutDir>` is whatever `--out-dir` was passed to the sweep (e.g.
 * `results/baseline-sweep-<timestamp>`). Also works on a single non-sweep eval
 * dir (pass `--baseline` with one id whose config matches that dir's mode/dynamic).
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, computeCostUsd, type Provider } from '@cleak/config';
import { loadBaselines } from './baselines';
import { resolveCapabilities } from '../apps/leak-inspector-tui/src/domain/capabilityResolver';
import { renderSweepMarkdown } from '../apps/leak-inspector-tui/src/domain/baselineSweep';
import { inspectBaselineDir, type BaselineInspection } from './inspectSweep';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

interface CostCtx {
  model?: string;
  pricing: Parameters<typeof computeCostUsd>[3];
}

function printProgressLine(run: Extract<BaselineInspection['runs'][number], { final: false }>, costCtx?: CostCtx): void {
  const p = run.progress;
  const llm = p.judgePathCounts.llm ?? 0;
  const heuristic = p.judgePathCounts.heuristic ?? 0;
  const consensus = p.judgePathCounts.consensus ?? 0;
  const llmTotal = llm + heuristic + consensus;
  const llmPct = llmTotal > 0 ? pct((llm + consensus) / llmTotal) : '—';
  const nonOk = Object.entries(p.statusCounts)
    .filter(([k]) => k !== 'ok')
    .reduce((a, [, v]) => a + v, 0);
  const precision = p.tp + p.fp > 0 ? pct(p.tp / (p.tp + p.fp)) : '—';
  const recall = p.tp + p.fn > 0 ? pct(p.tp / (p.tp + p.fn)) : '—';
  const okTotal = p.tp + p.fp + p.fn + p.tn;
  const liveF1 = okTotal > 0 && p.tp + p.fp > 0 && p.tp + p.fn > 0 ? (2 * p.tp) / (2 * p.tp + p.fp + p.fn) : undefined;
  const meanTokens = p.done > 0 ? p.totalTokens / p.done : 0;
  const cost = costCtx ? computeCostUsd(p.totalInputTokens, p.totalOutputTokens, costCtx.model, costCtx.pricing) : undefined;
  console.log(
    `   run-${run.run}: ▶ ${p.done} case(s) so far` +
      (nonOk ? ` ⚠ ${nonOk} non-ok (${JSON.stringify(p.statusCounts)})` : '') +
      (p.totalTruncatedCalls > 0 ? ` ⚠ ${p.totalTruncatedCalls} truncated (max_tokens)` : '') +
      ` · P ${precision} R ${recall}` +
      (liveF1 !== undefined ? ` F1≈${liveF1.toFixed(3)}` : '') +
      ` · judge llm+consensus% ${llmPct} · FP/KLOC ${p.fpPerKloc.toFixed(3)}` +
      ` · ${Math.round(meanTokens)} tok/case` +
      (cost?.priced ? ` · $${cost.costUsd!.toFixed(4)} so far` : cost ? ` · $unpriced (${costCtx?.model ?? 'no model'})` : ''),
  );
}

function main(): void {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--')) {
    console.error('Usage: pnpm exec tsx evaluation/inspect.ts <sweepOutDir> [--baselines-dir <dir>] [--baseline B1,B6b]');
    process.exit(1);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`No such directory: ${dir}`);
    process.exit(1);
  }

  const baselinesDir = flag('baselines-dir') ?? 'configs/baselines';
  const only = flag('baseline')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const configs = loadBaselines(baselinesDir, only);

  // Best-effort: cost-so-far for in-progress runs needs the model id + $/1M
  // pricing table — pulled from whatever cleak config is active right now
  // (--provider to match a run launched under a non-default profile). This is
  // a read-only inspector, so a bad/missing config must never crash it — just
  // fall back to reporting tokens without a $ figure.
  let costCtx: { model?: string; pricing: ReturnType<typeof loadConfig>['pricing'] } | undefined;
  try {
    const cfg = loadConfig({ provider: flag('provider') as Provider | undefined });
    costCtx = { model: cfg.llm.model, pricing: cfg.pricing };
  } catch {
    costCtx = undefined;
  }

  // Only inspect ids that actually have SOMETHING on disk in this dir — a fresh
  // sweep dir that hasn't reached B7 yet shouldn't print 6 "not started" lines.
  const inspections = configs
    .filter((c) => existsSync(join(dir, c.id)))
    .map((c) => {
      const plan = resolveCapabilities(c.capabilities, { consensusN: c.consensusN, runs: c.runs });
      return inspectBaselineDir(c.id, c.name, join(dir, c.id), plan.runs);
    });

  if (!inspections.length) {
    console.log(`No baseline output found under ${dir} for configs in ${baselinesDir}.`);
    return;
  }

  const complete = inspections.filter((i) => i.row);
  const partial = inspections.filter((i) => !i.row && i.runs.length > 0);

  if (complete.length) {
    console.log(renderSweepMarkdown(complete.map((i) => i.row!), { corpus: dir }));
  }

  if (partial.length) {
    console.log(complete.length ? '\n## In progress\n' : '');
    for (const i of partial) {
      const doneRuns = i.runs.filter((r) => r.final).length;
      console.log(`── ${i.id} ${i.name} (${doneRuns}/${i.totalRuns} run(s) fully cached)`);
      for (const r of i.runs) {
        if (r.final) {
          const m = r.result.overall;
          const c = r.result.cost;
          console.log(
            `   run-${r.run}: ✓ ${r.result.ranOk}/${r.result.caseCount} · P ${pct(m.precision)} R ${pct(m.recall)} F1 ${m.f1.toFixed(3)}` +
              ` · ${Math.round(c.meanTokens)} tok/case` +
              (c.priced ? ` · $${c.costUsd!.toFixed(4)} total` : '') +
              (c.totalTruncatedCalls > 0 ? ` · ⚠ ${c.totalTruncatedCalls} truncated (max_tokens)` : ''),
          );
        } else {
          printProgressLine(r, costCtx);
        }
      }
    }
    console.log();
  }

  const missing = configs.filter((c) => !existsSync(join(dir, c.id))).map((c) => c.id);
  if (missing.length) console.log(`(not started yet: ${missing.join(', ')})`);
}

main();
