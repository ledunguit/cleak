/**
 * The only file that calls `runEval`/`runEvalRepeated`/`writeEval` — everything
 * else in `evaluation/` builds a `ResolvedPlan` and hands it here. Mirrors
 * `scripts/evaluate-corpus.ts`'s main() output format so the two tools feel like
 * one family.
 */
import { join, basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import { runEval, runEvalRepeated, type EvalResult, type EvalOptions } from '../apps/leak-inspector-tui/src/domain/evalHarness';
import { writeEval } from '../apps/leak-inspector-tui/src/domain/evalReport';
import { createProgressCallbacks } from './progress';
import { varianceMarkdown } from './variance';
import type { ResolvedPlan } from './types';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function toEvalOptions(plan: ResolvedPlan): Omit<EvalOptions, 'outDir'> {
  return {
    corpusDir: plan.corpusDir,
    mode: plan.mode,
    dynamic: plan.dynamic,
    limit: plan.limit,
    stratify: plan.stratify,
    randomSeed: plan.randomSeed,
    concurrency: plan.concurrency,
    resume: plan.resume,
    staticUrl: plan.staticUrl,
    dynamicUrl: plan.dynamicUrl,
    allowUnvalidated: plan.allowUnvalidated,
    consensusN: plan.consensusN,
    consensusRule: plan.consensusRule,
    judgeCacheEnabled: plan.judgeCacheEnabled,
    strategy: plan.strategy,
    enrich: plan.enrich,
    toolSelect: plan.toolSelect,
    staticDiscovery: plan.staticDiscovery,
    staticTools: plan.staticTools,
    provider: plan.provider,
    maxCaseMs: plan.maxCaseMs,
    maxCaseCostUsd: plan.maxCaseCostUsd,
    maxConsecutiveErrors: plan.maxConsecutiveErrors,
  };
}

export function printResolvedPlan(plan: ResolvedPlan): void {
  console.log('DRY RUN — evaluation/cli.ts');
  console.log(`  corpus: ${plan.corpusDir}`);
  console.log(`  mode: ${plan.mode}`);
  console.log(`  dynamic: ${plan.dynamic}`);
  console.log(`  limit: ${plan.limit ?? 'all'}`);
  console.log(`  stratify: ${plan.stratify ?? 'none'}`);
  console.log(`  randomSeed: ${plan.randomSeed ?? 'none'}`);
  console.log(`  runs: ${plan.runs}`);
  console.log(`  resume: ${plan.resume ?? false}`);
  console.log(`  concurrency: ${plan.concurrency ?? 'auto (harness default)'}`);
  console.log(`  staticUrl: ${plan.staticUrl ?? '(config default)'}`);
  console.log(`  dynamicUrl: ${plan.dynamicUrl ?? '(config default)'}`);
  console.log(`  provider: ${plan.provider ?? '(config default)'}`);
  console.log(`  consensusN: ${plan.consensusN ?? 'default'}`);
  console.log(`  consensusRule: ${plan.consensusRule ?? 'default'}`);
  console.log(`  judgeCacheEnabled: ${plan.judgeCacheEnabled ?? 'default (true)'}${plan.runs > 1 && plan.judgeCacheEnabled !== false ? '  ⚠ runs>1 with the cache on will hide real LLM variance on repeats — pass --no-judge-cache' : ''}`);
  console.log(`  strategy: ${plan.strategy ?? 'default'}`);
  console.log(`  enrich: ${plan.enrich ?? 'default'}`);
  console.log(`  toolSelect: ${plan.toolSelect ?? 'default'}`);
  console.log(`  staticDiscovery: ${plan.staticDiscovery ?? 'default'}`);
  console.log(`  staticTools: ${plan.staticTools ?? 'default'}`);
  console.log(`  maxCaseMs: ${plan.maxCaseMs ?? 'off (config default)'}`);
  console.log(`  maxCaseCostUsd: ${plan.maxCaseCostUsd ?? 'off (config default)'}`);
  console.log(`  maxConsecutiveErrors: ${plan.maxConsecutiveErrors ?? 'default (config: eval.maxConsecutiveErrors)'}`);
  console.log(`  allowUnvalidated: ${plan.allowUnvalidated ?? false}`);
  console.log(`  outDir: ${plan.outDir}`);
  console.log(`  verbose: ${plan.verbose}`);
}

export async function run(plan: ResolvedPlan): Promise<void> {
  const base = toEvalOptions(plan);
  console.log(
    `Evaluating corpus=${plan.corpusDir} mode=${plan.mode} dynamic=${plan.dynamic} runs=${plan.runs}` +
      `${plan.limit ? ` limit=${plan.limit}` : ''}${plan.consensusN ? ` consensus-n=${plan.consensusN}` : ''}\n`,
  );

  if (plan.runs <= 1) {
    const cb = createProgressCallbacks(plan.verbose);
    const result: EvalResult = await runEval({ ...base, outDir: plan.outDir, ...cb });
    const files = writeEval(plan.outDir, result);
    const m = result.overall;
    console.log(`\n── ${plan.mode} ── ${result.ranOk}/${result.caseCount} scored`);
    console.log(`  P ${pct(m.precision)} · R ${pct(m.recall)} · F1 ${m.f1.toFixed(3)} · MCC ${m.mcc.toFixed(3)} · ECE ${result.ece.toFixed(3)}`);
    console.log(`  TP ${m.tp} FP ${m.fp} FN ${m.fn} TN ${m.tn}`);
    console.log(
      `  provenance: model=${result.provenance.model ?? '—'} temp=${result.provenance.temperature ?? '—'} commit=${result.provenance.gitCommit?.slice(0, 8) ?? '—'}`,
    );
    console.log(`\n✓ artifacts: ${files.map((f) => basename(f)).join(', ')} in ${plan.outDir}`);
    return;
  }

  const rep = await runEvalRepeated({ ...base, outDir: plan.outDir }, plan.runs);
  rep.perRun.forEach((result, k) => writeEval(join(plan.outDir, `run-${k + 1}`), result));
  writeFileSync(join(plan.outDir, 'variance.json'), JSON.stringify(rep, null, 2));
  writeFileSync(join(plan.outDir, 'variance.md'), varianceMarkdown(rep));
  const a = rep.aggregate;
  const pm = (s: { mean: number; std: number }) => `${(s.mean * 100).toFixed(1)}% ± ${(s.std * 100).toFixed(1)}`;
  console.log(`\n── ${plan.mode} · ${rep.runs} runs (mean ± std) ──`);
  console.log(`  P ${pm(a.precision)} · R ${pm(a.recall)} · F1 ${a.f1.mean.toFixed(3)} ± ${a.f1.std.toFixed(3)}`);
  console.log(`  MCC ${a.mcc.mean.toFixed(3)} ± ${a.mcc.std.toFixed(3)} · ECE ${a.ece.mean.toFixed(3)} ± ${a.ece.std.toFixed(3)}`);
  console.log(`\n✓ variance.json + per-run artifacts in ${plan.outDir}`);
}
