/**
 * Baseline ablation sweep support for the standalone eval CLI — runs one or more
 * `configs/baselines/*.yaml` capability profiles over a corpus and emits the same
 * comparison table `scripts/run-baselines.ts` does. Deliberately NOT sharing code
 * with `run-baselines.ts` (that script already produces thesis numbers people
 * have relied on this session — duplicating its ~80 lines here, rather than
 * refactoring it, keeps that script's behavior pinned while this one gains the
 * same capability through the ingest-aware wizard/CLI).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadBaselineConfigs, type BaselineConfig } from '../apps/leak-inspector-tui/src/domain/baselineConfig';
import { resolveCapabilities } from '../apps/leak-inspector-tui/src/domain/capabilityResolver';
import {
  isWiredNow,
  renderSweepMarkdown,
  renderSweepCsv,
  renderSweepLatex,
  type BaselineSweepRow,
  type SweepMeta,
} from '../apps/leak-inspector-tui/src/domain/baselineSweep';
import { runEval, runEvalRepeated } from '../apps/leak-inspector-tui/src/domain/evalHarness';
import { writeEval } from '../apps/leak-inspector-tui/src/domain/evalReport';
import type { Provider } from '@cleak/config';

/** Load `configs/baselines/*.yaml`, optionally filtered to the given ids (order
 * preserved as loaded — id-sorted, matching run-baselines.ts). */
export function loadBaselines(dir: string, only?: string[]): BaselineConfig[] {
  const configs = loadBaselineConfigs(dir);
  if (!only?.length) return configs;
  return configs.filter((c) => only.includes(c.id));
}

export interface SweepOptions {
  corpusDir: string;
  outDir: string;
  limit?: number;
  stratify?: string;
  resume?: boolean;
  concurrency?: number;
  staticUrl?: string;
  dynamicUrl?: string;
  provider?: Provider;
  allowUnvalidated?: boolean;
  consensusOverride?: number;
  runsOverride?: number;
  enrichOverride?: boolean;
  staticTools?: string[];
  includeUnwired?: boolean;
  /** Per-baseline-run circuit breaker override — see EvalOptions.maxConsecutiveErrors.
   * Undefined = each run falls back to cleak config's eval.maxConsecutiveErrors. */
  maxConsecutiveErrors?: number;
  /** Judge-verdict disk-cache override. IMPORTANT whenever any swept baseline has
   * `runs > 1` (repeat-for-variance, e.g. the fusion baselines B4-B7) — a cache hit
   * on repeat 2+ would replay repeat 1's verdict, hiding real LLM run-to-run
   * variance. Default (unset) leaves the global config value (true). */
  judgeCacheEnabled?: boolean;
}

function gitCommit(): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
}

export function printSweepDryRun(
  configs: BaselineConfig[],
  opts: Pick<SweepOptions, 'consensusOverride' | 'runsOverride' | 'judgeCacheEnabled'>,
): void {
  console.log('DRY RUN — resolved baseline plans (nothing executed):\n');
  const anyRepeats = configs.some((c) => (opts.runsOverride ?? c.runs ?? 1) > 1);
  if (anyRepeats && opts.judgeCacheEnabled !== false) {
    console.log(
      '⚠ at least one config has runs>1 (repeat-for-variance) and the judge cache is not ' +
        'disabled — a cache hit on repeat 2+ will replay repeat 1\'s verdict, hiding real LLM ' +
        'run-to-run variance. Pass --no-judge-cache for a trustworthy variance measurement.\n',
    );
  }
  console.log(`  judgeCacheEnabled: ${opts.judgeCacheEnabled ?? 'default (true)'}\n`);
  for (const c of configs) {
    const plan = resolveCapabilities(c.capabilities, { consensusN: opts.consensusOverride ?? c.consensusN, runs: opts.runsOverride ?? c.runs });
    const w = isWiredNow(plan);
    console.log(
      `  ${c.id.padEnd(4)} ${c.name.padEnd(28)} mode=${plan.mode} dyn=${plan.dynamic} strat=${plan.strategy} ` +
        `toolSel=${plan.toolSelect} static=${plan.staticDiscovery} enrich=${plan.enrich} runs=${plan.runs} ` +
        `${w.wired ? '✓ wired' : `✗ ${w.reason}`}`,
    );
  }
}

/** Run every config in `configs` over the same corpus, writing per-config eval
 * artifacts under `<outDir>/<id>/` plus a sweep comparison table (md/csv/tex/json)
 * at `<outDir>/baseline-sweep.*` — same shape scripts/run-baselines.ts produces. */
export async function runBaselineSweep(configs: BaselineConfig[], opts: SweepOptions): Promise<void> {
  mkdirSync(opts.outDir, { recursive: true });
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const meta: SweepMeta = { corpus: opts.corpusDir, limit: opts.limit, generatedAt: new Date().toISOString(), gitCommit: gitCommit() };

  console.log(
    `Baseline sweep · corpus=${opts.corpusDir}${opts.limit ? ` limit=${opts.limit}` : ''}` +
      `${opts.stratify ? ` stratify=${opts.stratify}` : ''}${opts.provider ? ` provider=${opts.provider}` : ''} · ${configs.length} config(s)\n`,
  );

  const rows: BaselineSweepRow[] = [];
  let circuitBrokenAt: string | undefined;
  for (const c of configs) {
    const plan = resolveCapabilities(c.capabilities, { consensusN: opts.consensusOverride ?? c.consensusN, runs: opts.runsOverride ?? c.runs });
    const wired = isWiredNow(plan);
    if (!wired.wired && !opts.includeUnwired) {
      console.log(`── ${c.id} ${c.name}: SKIPPED (${wired.reason})`);
      rows.push({ id: c.id, name: c.name, status: 'skipped', skipReason: wired.reason });
      continue;
    }

    const caseOut = join(opts.outDir, c.id);
    const evalOpts = {
      corpusDir: opts.corpusDir,
      mode: plan.mode,
      dynamic: plan.dynamic,
      outDir: caseOut,
      limit: opts.limit,
      resume: opts.resume,
      concurrency: opts.concurrency,
      staticUrl: opts.staticUrl,
      dynamicUrl: opts.dynamicUrl,
      consensusN: plan.consensusN,
      judgeCacheEnabled: opts.judgeCacheEnabled,
      strategy: plan.strategy,
      enrich: opts.enrichOverride ?? plan.enrich,
      toolSelect: plan.toolSelect,
      staticDiscovery: plan.staticDiscovery,
      provider: opts.provider,
      stratify: opts.stratify,
      allowUnvalidated: opts.allowUnvalidated,
      maxConsecutiveErrors: opts.maxConsecutiveErrors,
      ...(opts.staticTools ? { staticTools: opts.staticTools } : {}),
    };

    try {
      let row: BaselineSweepRow;
      let circuitBroken = false;
      if (plan.runs <= 1) {
        const r = await runEval({ ...evalOpts });
        writeEval(caseOut, r);
        circuitBroken = !!r.circuitBroken;
        row = {
          id: c.id,
          name: c.name,
          status: 'ok',
          ...(circuitBroken ? { error: 'circuit breaker tripped — run cut short, numbers are partial' } : {}),
          ranOk: r.ranOk,
          caseCount: r.caseCount,
          runs: 1,
          tp: r.overall.tp,
          fp: r.overall.fp,
          fn: r.overall.fn,
          tn: r.overall.tn,
          precision: r.overall.precision,
          recall: r.overall.recall,
          f1: r.overall.f1,
          fpPerKloc: r.cost.fpPerKloc,
          ece: r.ece,
          meanDurationMs: r.cost.meanDurationMs,
          meanMcpCalls: r.cost.meanMcpCalls,
          meanTokens: r.cost.meanTokens,
          totalTokens: r.cost.totalTokens,
          totalCostUsd: r.cost.priced ? r.cost.costUsd : undefined,
        };
      } else {
        const rep = await runEvalRepeated({ ...evalOpts }, plan.runs);
        rep.perRun.forEach((r, i) => writeEval(join(caseOut, `run-${i + 1}`), r));
        writeFileSync(join(caseOut, 'variance.json'), JSON.stringify(rep, null, 2));
        circuitBroken = rep.perRun.some((r) => r.circuitBroken);
        const mean = (sel: (r: (typeof rep.perRun)[number]) => number) => rep.perRun.reduce((a, r) => a + sel(r), 0) / rep.perRun.length;
        const meanRound = (sel: (r: (typeof rep.perRun)[number]) => number) => Math.round(mean(sel));
        row = {
          id: c.id,
          name: c.name,
          status: 'ok',
          ...(circuitBroken ? { error: `circuit breaker tripped in ${rep.perRun.length}/${plan.runs} run(s) — numbers are partial` } : {}),
          ranOk: meanRound((r) => r.ranOk),
          caseCount: rep.perRun[0]?.caseCount,
          runs: rep.runs,
          tp: meanRound((r) => r.overall.tp),
          fp: meanRound((r) => r.overall.fp),
          fn: meanRound((r) => r.overall.fn),
          tn: meanRound((r) => r.overall.tn),
          precision: rep.aggregate.precision.mean,
          recall: rep.aggregate.recall.mean,
          f1: rep.aggregate.f1.mean,
          f1Std: rep.aggregate.f1.std,
          fpPerKloc: mean((r) => r.cost.fpPerKloc),
          ece: rep.aggregate.ece.mean,
          meanDurationMs: mean((r) => r.cost.meanDurationMs),
          meanMcpCalls: mean((r) => r.cost.meanMcpCalls),
          meanTokens: mean((r) => r.cost.meanTokens),
          totalTokens: rep.perRun.reduce((a, r) => a + r.cost.totalTokens, 0),
          totalCostUsd: rep.perRun[0]?.cost.priced ? rep.perRun.reduce((a, r) => a + (r.cost.costUsd ?? 0), 0) : undefined,
        };
      }
      rows.push(row);
      if (row.status === 'ok') {
        console.log(
          `── ${c.id} ${c.name}: P ${pct(row.precision!)} R ${pct(row.recall!)} F1 ${row.f1!.toFixed(3)}` +
            ` · FP/KLOC ${row.fpPerKloc!.toFixed(3)} · ${Math.round(row.meanMcpCalls!)} MCP/case · ${Math.round(row.meanTokens!)} tok/case`,
        );
      }
      if (circuitBroken) {
        circuitBrokenAt = c.id;
        console.log(
          `\n⛔ ${c.id}: circuit breaker tripped — provider looks dead/exhausted. ` +
            `Stopping the sweep here instead of burning through the remaining configs. ` +
            `Re-run the SAME command with --resume once fixed.\n`,
        );
        break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      rows.push({ id: c.id, name: c.name, status: 'error', error: msg });
      console.log(`── ${c.id} ${c.name}: ERROR ${msg}`);
    }
  }

  if (circuitBrokenAt) {
    for (const c of configs.slice(rows.length)) {
      rows.push({ id: c.id, name: c.name, status: 'skipped', skipReason: `sweep stopped: circuit breaker tripped in ${circuitBrokenAt}` });
    }
  }

  const md = renderSweepMarkdown(rows, meta);
  writeFileSync(join(opts.outDir, 'baseline-sweep.md'), md);
  writeFileSync(join(opts.outDir, 'baseline-sweep.csv'), renderSweepCsv(rows));
  writeFileSync(join(opts.outDir, 'baseline-sweep.tex'), renderSweepLatex(rows, meta));
  writeFileSync(join(opts.outDir, 'baseline-sweep.json'), JSON.stringify({ meta, rows }, null, 2));
  console.log(`\n✓ sweep table (md/csv/tex/json) in ${opts.outDir}`);
  console.log('\n' + md);
}
