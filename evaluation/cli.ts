#!/usr/bin/env -S pnpm exec tsx
/**
 * Standalone evaluation CLI entrypoint — the non-TUI equivalent of the TUI's
 * `/eval` wizard. `pnpm run eval:wizard [mode] [flags]`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkCorpusGate } from '../apps/leak-inspector-tui/src/domain/corpusLock';
import { parseFlags, HELP_TEXT, type CliFlags } from './flags';
import { runWizard, pickCorpus } from './wizard';
import { printResolvedPlan, run } from './run';
import { loadBaselines, printSweepDryRun, runBaselineSweep } from './baselines';
import type { ResolvedPlan } from './types';

function requireValidatedCorpusDir(flags: CliFlags): string {
  if (!flags.corpus) {
    console.error('✗ --corpus is required in non-interactive mode (or pass --interactive / omit --corpus for the wizard).');
    process.exit(1);
  }
  const corpusDir = resolve(flags.corpus);
  if (!flags.allowUnvalidated) {
    if (!existsSync(`${corpusDir}/corpus_manifest.json`)) {
      console.error(`✗ no corpus_manifest.json under ${corpusDir}. Run with --interactive to ingest it, or --allow-unvalidated to bypass.`);
      process.exit(1);
    }
    const gate = checkCorpusGate(corpusDir);
    if (!gate.ok) {
      console.error(`✗ corpus gate failed: ${gate.reason}. Run with --interactive to ingest/validate, or --allow-unvalidated to bypass.`);
      process.exit(1);
    }
  }
  return corpusDir;
}

function resolvePlanFromFlags(flags: CliFlags): ResolvedPlan {
  const corpusDir = requireValidatedCorpusDir(flags);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    corpusDir,
    mode: flags.mode ?? 'llm_assisted',
    dynamic: flags.dynamic ?? 'off',
    outDir: flags.outDir ?? `results/eval-${flags.mode ?? 'llm_assisted'}-${stamp}`,
    limit: flags.limit,
    stratify: flags.stratify,
    randomSeed: flags.randomSeed,
    concurrency: flags.concurrency,
    resume: flags.resume,
    staticUrl: flags.staticUrl,
    dynamicUrl: flags.dynamicUrl,
    runs: flags.runs ?? 1,
    allowUnvalidated: flags.allowUnvalidated,
    consensusN: flags.consensusN,
    consensusRule: flags.consensusRule,
    strategy: flags.strategy,
    enrich: flags.enrich,
    toolSelect: flags.toolSelect,
    staticDiscovery: flags.staticDiscovery,
    staticTools: flags.staticTools,
    provider: flags.provider,
    maxCaseMs: flags.maxCaseMs,
    maxCaseCostUsd: flags.maxCaseCostUsd,
    verbose: flags.verbose,
  };
}

/** Sweep one or more `configs/baselines/*.yaml` capability profiles over a corpus —
 * `--baseline <id[,id...]>` / `--all-baselines`, or picked interactively when no
 * explicit flags disambiguate custom-vs-baseline mode. Reuses the same corpus
 * picker + auto-ingest sub-flow as the single-plan wizard. */
async function runBaselineMode(flags: CliFlags): Promise<void> {
  const baselinesDir = flags.baselinesDir ?? 'configs/baselines';
  const only = flags.allBaselines ? undefined : flags.baseline;
  const configs = loadBaselines(baselinesDir, only);
  if (!configs.length) {
    console.error(`✗ no baseline configs matched${only ? ` --baseline ${only.join(',')}` : ''} in ${baselinesDir}`);
    process.exit(1);
  }

  const interactive = !flags.corpus || flags.interactive;
  let corpusDir: string;
  if (interactive) {
    const entry = await pickCorpus(flags);
    if (!entry) {
      console.log('No corpus selected — exiting.');
      return;
    }
    corpusDir = entry.outDir;
  } else {
    corpusDir = requireValidatedCorpusDir(flags);
  }

  if (flags.dryRun) {
    printSweepDryRun(configs, { consensusOverride: flags.consensusN, runsOverride: flags.runs });
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = flags.outDir ?? `results/baseline-sweep-${stamp}`;

  if (interactive) {
    printSweepDryRun(configs, { consensusOverride: flags.consensusN, runsOverride: flags.runs });
    const { confirm } = await import('@inquirer/prompts');
    const go = await confirm({ message: `Run ${configs.length} baseline config(s) against ${corpusDir} now?`, default: true });
    if (!go) {
      console.log('Cancelled.');
      return;
    }
  }

  await runBaselineSweep(configs, {
    corpusDir,
    outDir,
    limit: flags.limit,
    stratify: flags.stratify,
    resume: flags.resume,
    concurrency: flags.concurrency,
    staticUrl: flags.staticUrl,
    dynamicUrl: flags.dynamicUrl,
    provider: flags.provider,
    allowUnvalidated: flags.allowUnvalidated,
    consensusOverride: flags.consensusN,
    runsOverride: flags.runs,
    enrichOverride: flags.enrich,
    staticTools: flags.staticTools,
    includeUnwired: flags.includeUnwired,
  });
}

async function main(): Promise<void> {
  const flags = parseFlags();

  if (flags.help) {
    console.log(HELP_TEXT);
    return;
  }

  for (const spec of flags.setEndpoint) {
    const m = /^([a-z-]+)\.([a-zA-Z]+)=(.+)$/.exec(spec);
    if (!m) {
      console.error(`✗ --set-endpoint expects <provider>.<field>=<value>, got: ${spec}`);
      process.exit(1);
    }
    const { persistEndpointOverride } = await import('./providerSetup');
    persistEndpointOverride(m[1] as any, m[2] as any, m[3]);
    console.log(`✓ persisted endpoints.${m[1]}.${m[2]}`);
  }

  const interactive = !flags.corpus || flags.interactive;
  const explicitBaselineMode = (flags.baseline?.length ?? 0) > 0 || flags.allBaselines;

  if (explicitBaselineMode) {
    await runBaselineMode(flags);
    return;
  }

  if (interactive) {
    const { select } = await import('@inquirer/prompts');
    const runKind = await select<'custom' | 'baseline'>({
      message: 'Run a single custom configuration, or a baseline ablation config from configs/baselines/?',
      choices: [
        { value: 'custom', name: 'Custom (choose mode/dynamic/provider/… yourself)' },
        { value: 'baseline', name: 'Baseline config(s) from configs/baselines/ (B1..B7)' },
      ],
      default: 'custom',
    });
    if (runKind === 'baseline') {
      await runBaselineMode(flags);
      return;
    }
  }

  const plan = interactive ? await runWizard(flags) : resolvePlanFromFlags(flags);
  if (!plan) return; // wizard cancelled

  if (flags.dryRun) {
    printResolvedPlan(plan);
    return;
  }

  if (interactive) {
    const { confirm } = await import('@inquirer/prompts');
    printResolvedPlan(plan);
    const go = await confirm({ message: 'Run now?', default: true });
    if (!go) {
      console.log('Cancelled.');
      return;
    }
  }

  await run(plan);
}

main().catch((err) => {
  if (err?.name === 'ExitPromptError') {
    console.log('\nCancelled.');
    process.exit(130);
  }
  console.error(err);
  process.exit(1);
});
