#!/usr/bin/env bun
/**
 * Baseline ablation sweep. Runs the 9 declarative baseline configs
 * (configs/baselines/*.yaml) on one corpus through the SAME eval harness + scorer,
 * and emits a single comparison table (Markdown / CSV / LaTeX) over the thesis
 * metrics: Precision · Recall · F1 · FP/KLOC · runtime · #MCP calls · token cost.
 *
 *   bun scripts/run-baselines.ts --corpus demo/juliet_cwe401 --limit 300
 *   bun scripts/run-baselines.ts --only B1,B3 --corpus demo/juliet_cwe401
 *   bun scripts/run-baselines.ts --dry-run            # print resolved plans, run nothing
 *
 * Each config maps to engine knobs via capabilityResolver. Deterministic configs
 * (fusion off) run once; fusion configs run `runs` times and F1 is reported mean±std.
 * Configs whose semantics aren't wired yet (dynamic-only → Step 4a; deterministic-
 * recipe fusion → Step 4b) are SKIPPED unless --include-unwired is passed.
 *
 * MCP analyzers: override EVAL_STATIC_URL / EVAL_DYNAMIC_URL (default :50071/:50072).
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
import { loadEnvFiles } from '../apps/leak-inspector-tui/src/domain/env';

loadEnvFiles();

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const baselinesDir = flag('baselines') ?? 'configs/baselines';
const corpusDir = flag('corpus') ?? process.env.CORPUS_DIR ?? 'demo/juliet_cwe401';
const limit = flag('limit') ? parseInt(flag('limit')!, 10) : undefined;
const only = flag('only')?.split(',').map((s) => s.trim());
const staticUrl = process.env.EVAL_STATIC_URL ?? 'http://127.0.0.1:50071/mcp';
const dynamicUrl = process.env.EVAL_DYNAMIC_URL ?? 'http://127.0.0.1:50072/mcp';
const dryRun = has('dry-run');
const includeUnwired = has('include-unwired');
const consensusOverride = flag('consensus-n') ? Math.max(1, parseInt(flag('consensus-n')!, 10)) : undefined;
// Override every config's `runs` (handy for a cheap smoke check of fusion baselines).
const runsOverride = flag('runs') ? Math.max(1, parseInt(flag('runs')!, 10)) : undefined;
// Cases run in parallel per config (default: harness picks 6 for no_llm, 3 for llm).
// Raising this parallelizes the LLM/strategist + build calls (mind gateway rate limits).
const concurrency = flag('concurrency') ? Math.max(1, parseInt(flag('concurrency')!, 10)) : undefined;
// Reuse per-case caches under the out dir — lets an interrupted sweep continue.
const resume = has('resume');
// LLM provider override (eval-scoped) — bypass the cleak config file's provider so a
// sweep can target a known-good gateway (e.g. `--provider local` for the .env gateway)
// without editing ~/.config/cleak/config.json.
const provider = flag('provider') as 'local' | 'openai' | 'anthropic' | 'openai-compat' | undefined;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = flag('out') ?? join(process.env.RESULTS_DIR ?? 'results', `baseline-sweep-${stamp}`);

let configs = loadBaselineConfigs(baselinesDir);
if (only) configs = configs.filter((c) => only.includes(c.id));
if (!configs.length) {
  console.error(`No baseline configs matched${only ? ` --only ${only.join(',')}` : ''} in ${baselinesDir}`);
  process.exit(1);
}

const gitCommit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
})();
const meta: SweepMeta = { corpus: corpusDir, limit, generatedAt: new Date().toISOString(), gitCommit };

console.log(`Baseline sweep · corpus=${corpusDir}${limit ? ` limit=${limit}` : ''} · ${configs.length} config(s)\n`);

if (dryRun) {
  console.log('DRY RUN — resolved plans (nothing executed):\n');
  for (const c of configs) {
    const plan = resolveCapabilities(c.capabilities, { consensusN: consensusOverride ?? c.consensusN, runs: runsOverride ?? c.runs });
    const w = isWiredNow(plan);
    console.log(
      `  ${c.id.padEnd(4)} ${c.name.padEnd(28)} mode=${plan.mode} dyn=${plan.dynamic} strat=${plan.strategy} ` +
        `toolSel=${plan.toolSelect} static=${plan.staticDiscovery} enrich=${plan.enrich} runs=${plan.runs} ` +
        `${w.wired ? '✓ wired' : `✗ ${w.reason}`}`,
    );
  }
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const rows: BaselineSweepRow[] = [];
for (const c of configs) {
  const plan = resolveCapabilities(c.capabilities, { consensusN: consensusOverride ?? c.consensusN, runs: runsOverride ?? c.runs });
  const wired = isWiredNow(plan);
  if (!wired.wired && !includeUnwired) {
    console.log(`── ${c.id} ${c.name}: SKIPPED (${wired.reason})`);
    rows.push({ id: c.id, name: c.name, status: 'skipped', skipReason: wired.reason });
    continue;
  }
  const row = await runOne(c, plan);
  rows.push(row);
  if (row.status === 'ok') {
    console.log(
      `── ${c.id} ${c.name}: P ${pct(row.precision!)} R ${pct(row.recall!)} F1 ${row.f1!.toFixed(3)}` +
        ` · FP/KLOC ${row.fpPerKloc!.toFixed(3)} · ${Math.round(row.meanMcpCalls!)} MCP/case · ${Math.round(row.meanTokens!)} tok/case`,
    );
  } else {
    console.log(`── ${c.id} ${c.name}: ERROR ${row.error}`);
  }
}

const md = renderSweepMarkdown(rows, meta);
writeFileSync(join(outDir, 'baseline-sweep.md'), md);
writeFileSync(join(outDir, 'baseline-sweep.csv'), renderSweepCsv(rows));
writeFileSync(join(outDir, 'baseline-sweep.tex'), renderSweepLatex(rows, meta));
writeFileSync(join(outDir, 'baseline-sweep.json'), JSON.stringify({ meta, rows }, null, 2));
console.log(`\n✓ sweep table (md/csv/tex/json) in ${outDir}`);
console.log('\n' + md);

/** Run a single baseline and fold its EvalResult(s) into a sweep row. */
async function runOne(c: BaselineConfig, plan: ReturnType<typeof resolveCapabilities>): Promise<BaselineSweepRow> {
  const caseOut = join(outDir, c.id);
  const evalOpts = {
    corpusDir,
    mode: plan.mode,
    dynamic: plan.dynamic,
    outDir: caseOut,
    limit,
    resume,
    concurrency,
    staticUrl,
    dynamicUrl,
    consensusN: plan.consensusN,
    strategy: plan.strategy,
    enrich: plan.enrich,
    toolSelect: plan.toolSelect,
    staticDiscovery: plan.staticDiscovery,
    provider,
  };
  try {
    if (plan.runs <= 1) {
      const r = await runEval({ ...evalOpts });
      writeEval(caseOut, r);
      return {
        id: c.id,
        name: c.name,
        status: 'ok',
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
      };
    }
    const rep = await runEvalRepeated({ ...evalOpts }, plan.runs);
    for (let i = 0; i < rep.perRun.length; i++) writeEval(join(caseOut, `run-${i + 1}`), rep.perRun[i]);
    writeFileSync(join(caseOut, 'variance.json'), JSON.stringify(rep, null, 2));
    const mean = (sel: (r: (typeof rep.perRun)[number]) => number) =>
      rep.perRun.reduce((a, r) => a + sel(r), 0) / rep.perRun.length;
    const meanRound = (sel: (r: (typeof rep.perRun)[number]) => number) => Math.round(mean(sel));
    return {
      id: c.id,
      name: c.name,
      status: 'ok',
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
    };
  } catch (err: any) {
    return { id: c.id, name: c.name, status: 'error', error: err?.message ?? String(err) };
  }
}
