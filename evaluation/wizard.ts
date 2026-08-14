/**
 * Interactive wizard: 7 basic prompts (mirrors the TUI's /eval wizard defaults
 * 1:1) + one "Advanced options?" gate covering every EvalOptions field the TUI
 * wizard doesn't expose. Any field already supplied via CLI flag is pre-seeded
 * as that prompt's default (or skipped outright if --yes is set and the flag
 * already resolves it).
 */
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { select, confirm, input, number, checkbox, password, Separator } from '@inquirer/prompts';
import { PROVIDERS, type Provider } from '@cleak/config';
import { checkCorpusGate } from '../apps/leak-inspector-tui/src/domain/corpusLock';
import { buildCatalog, statusLabel, type CatalogEntry } from './corpusCatalog';
import { runJulietIngest, runLamedIngest, runMemhintIngest, runValidateAndLock, extractZip, downloadFile } from './ingestRunners';
import { currentProviderSummary, persistEndpointOverride } from './providerSetup';
import type { CliFlags } from './flags';
import type { ResolvedPlan } from './types';

const JULIET_NIST_URL = 'https://samate.nist.gov/SARD/downloads/test-suites/2017-10-01-juliet-test-suite-for-c-cplusplus-v1-3.zip';

/** Real-project, positive-only corpora where --enrich materially matters
 * (docs/DATASETS.md: recall 15.9% → 29.5% on LAMeD with --enrich). */
function isRealProjectCorpus(entry: CatalogEntry): boolean {
  return entry.ingestKind === 'lamed' || entry.ingestKind === 'memhint';
}

async function ingestJuliet(outDir: string, flags: CliFlags): Promise<boolean> {
  let extractedRoot: string | undefined;

  if (flags.julietRoot) {
    if (!existsSync(resolve(flags.julietRoot))) {
      console.error(`✗ --juliet-root not found: ${flags.julietRoot}`);
      return false;
    }
    extractedRoot = resolve(flags.julietRoot);
  } else if (flags.julietZip) {
    const p = resolve(flags.julietZip);
    if (!existsSync(p)) {
      console.error(`✗ --juliet-zip not found: ${p}`);
      return false;
    }
    const scratchDir = resolve('evaluation/.cache/juliet-extract');
    extractZip(p, scratchDir);
    extractedRoot = scratchDir;
  } else {
    const defaultZip = existsSync(resolve('juliet.zip')) ? './juliet.zip' : undefined;
    const pathAnswer = await input({
      message: 'Path to an already-extracted Juliet root, or a .zip file (blank to look for a download instead):',
      default: defaultZip,
    });

    if (pathAnswer.trim()) {
      const p = resolve(pathAnswer.trim());
      if (p.endsWith('.zip')) {
        if (!existsSync(p)) {
          console.error(`✗ zip not found: ${p}`);
          return false;
        }
        const doExtract = await confirm({ message: `Extract ${basename(p)} via \`unzip\`?`, default: true });
        if (!doExtract) return false;
        const scratchDir = resolve('evaluation/.cache/juliet-extract');
        extractZip(p, scratchDir);
        extractedRoot = scratchDir;
      } else if (existsSync(p)) {
        extractedRoot = p;
      } else {
        console.error(`✗ path not found: ${p}`);
        return false;
      }
    } else {
      const doDownload = await confirm({
        message: `No local zip/root given. Download the ~150MB NIST Juliet zip now? (${JULIET_NIST_URL})`,
        default: false,
      });
      if (!doDownload) {
        console.log('  See docs/DATASETS.md for the manual download steps, then re-run this wizard.');
        return false;
      }
      const zipPath = resolve('evaluation/.cache/juliet.zip');
      downloadFile(JULIET_NIST_URL, zipPath);
      const scratchDir = resolve('evaluation/.cache/juliet-extract');
      extractZip(zipPath, scratchDir);
      extractedRoot = scratchDir;
    }
  }

  runJulietIngest(extractedRoot!, outDir);
  runValidateAndLock(outDir, {});
  return true;
}

async function ingestFlow(entry: CatalogEntry, flags: CliFlags): Promise<boolean> {
  console.log(`\n  ${entry.label}: ${entry.status === 'not-ingested' ? 'no corpus_manifest.json' : entry.gate?.reason}`);
  const doIngest = flags.autoIngest || flags.yes ? true : await confirm({ message: 'Ingest/validate now?', default: false });
  if (!doIngest) return false;

  const kind = entry.ingestKind ?? flags.ingestKind;
  switch (kind) {
    case 'lamed':
      runLamedIngest(entry.outDir);
      runValidateAndLock(entry.outDir, { strictLabels: true, skipCompile: true });
      break;
    case 'memhint':
      runMemhintIngest(entry.outDir);
      runValidateAndLock(entry.outDir, { strictLabels: true, skipCompile: true });
      break;
    case 'juliet': {
      const ok = await ingestJuliet(entry.outDir, flags);
      if (!ok) return false;
      break;
    }
    default:
      console.error(`  ✗ don't know how to ingest '${entry.label}' — pass --ingest-kind <juliet|lamed|memhint> for a fresh/unknown dir`);
      return false;
  }

  const gate = checkCorpusGate(entry.outDir);
  if (!gate.ok) {
    console.error(`  ✗ still not valid after ingest: ${gate.reason}`);
    return false;
  }
  console.log('  ✓ ingested and validated.');
  return true;
}

/** Exported so cli.ts's baseline-sweep mode can reuse the same corpus-pick +
 * auto-ingest sub-flow without going through the rest of the single-plan wizard. */
export async function pickCorpus(flags: CliFlags): Promise<CatalogEntry | undefined> {
  if (flags.corpus) {
    const abs = resolve(flags.corpus);
    const catalog = buildCatalog();
    const found = catalog.find((c) => c.outDir === abs);
    if (found) return maybeIngest(found, flags);
    // Seeded via --corpus with a path not in the catalog (fresh/custom corpus) —
    // status is not-ingested unless a manifest already happens to be there.
    const hasManifest = existsSync(join(abs, 'corpus_manifest.json'));
    const gate = hasManifest ? checkCorpusGate(abs) : undefined;
    const entry: CatalogEntry = {
      key: flags.corpus,
      label: flags.corpus,
      outDir: abs,
      status: !hasManifest ? 'not-ingested' : gate!.ok ? 'validated' : 'unvalidated-has-manifest',
      gate,
      ingestKind: flags.ingestKind,
    };
    return maybeIngest(entry, flags);
  }
  for (;;) {
    const catalog = buildCatalog();
    const choice = await select<string>({
      message: 'Corpus:',
      choices: [...catalog.map((c) => ({ value: c.outDir, name: statusLabel(c) })), new Separator(), { value: '__other__', name: 'Other… (enter a path)' }],
    });
    if (choice === '__other__') {
      const p = await input({ message: 'Corpus directory path:' });
      const abs = resolve(p);
      const gate = existsSync(join(abs, 'corpus_manifest.json')) ? checkCorpusGate(abs) : undefined;
      const entry: CatalogEntry = { key: p, label: p, outDir: abs, status: gate?.ok ? 'validated' : 'unvalidated-has-manifest', gate };
      const resolved = await maybeIngest(entry, flags);
      if (resolved) return resolved;
      continue;
    }
    const entry = catalog.find((c) => c.outDir === choice)!;
    const resolved = await maybeIngest(entry, flags);
    if (resolved) return resolved;
  }
}

async function maybeIngest(entry: CatalogEntry, flags: CliFlags): Promise<CatalogEntry | undefined> {
  if (entry.status === 'validated') return entry;
  const ok = await ingestFlow(entry, flags);
  if (!ok) return undefined;
  const gate = checkCorpusGate(entry.outDir);
  return { ...entry, status: 'validated', gate };
}

export async function runWizard(seed: CliFlags): Promise<ResolvedPlan | undefined> {
  const corpus = await pickCorpus(seed);
  if (!corpus) {
    console.log('No corpus selected — exiting.');
    return undefined;
  }

  // Sample size
  let limit: number | undefined = seed.limit;
  let stratify: string | undefined = seed.stratify;
  let randomSeed: number | undefined = seed.randomSeed;
  if (limit === undefined) {
    const sampleAll = await select<'all' | 'n'>({
      message: 'Sample size:',
      choices: [
        { value: 'all', name: 'All cases' },
        { value: 'n', name: 'N cases' },
      ],
      default: 'all',
    });
    if (sampleAll === 'n') {
      limit = await number({ message: 'How many cases?', default: 50, min: 1 });
      const samplingMode = await select<'sequential' | 'random' | 'stratified'>({
        message: 'Sampling mode:',
        choices: [
          { value: 'sequential', name: 'Sequential (first N in manifest order)' },
          { value: 'random', name: 'Random (seeded, reproducible)' },
          { value: 'stratified', name: 'Stratified (evenly by variant)' },
        ],
        default: 'sequential',
      });
      if (samplingMode === 'random') randomSeed = Math.floor(Math.random() * 1e9);
      if (samplingMode === 'stratified') stratify = await input({ message: 'Stratify by case field:', default: 'functionalVariant' });
    }
  }

  const mode = seed.mode ?? (await select<'llm_assisted' | 'no_llm'>({
    message: 'Analysis mode:',
    choices: [
      { value: 'llm_assisted', name: 'llm_assisted' },
      { value: 'no_llm', name: 'no_llm (deterministic heuristic)' },
    ],
    default: 'llm_assisted',
  }));

  const dynamic = seed.dynamic ?? (await select<'off' | 'selective' | 'aggressive'>({
    message: 'Dynamic analysis:',
    choices: [
      { value: 'off', name: 'off' },
      { value: 'selective', name: 'selective' },
      { value: 'aggressive', name: 'aggressive' },
    ],
    default: 'off',
  }));

  const concurrency =
    seed.concurrency ??
    (await number({
      message: 'Concurrency (blank = harness default 3; 8–12 profiled well for static-only Juliet-scale runs — raises MCP load, raise cautiously):',
      required: false,
    }));

  let outDir = seed.outDir;
  const resume = seed.resume ?? (await confirm({ message: 'Resume (reuse cached per-case results)?', default: false }));
  if (resume && !outDir) {
    outDir = await input({ message: 'Out dir to resume from (required for --resume to find anything):' });
  }

  let consensusN = seed.consensusN;
  let consensusRule = seed.consensusRule;
  let strategy = seed.strategy;
  let enrich = seed.enrich;
  let toolSelect = seed.toolSelect;
  let staticDiscovery = seed.staticDiscovery;
  let staticTools = seed.staticTools;
  let maxCaseMs = seed.maxCaseMs;
  let maxCaseCostUsd = seed.maxCaseCostUsd;
  let runs = seed.runs ?? 1;
  let provider = seed.provider;

  const wantsAdvanced = await confirm({ message: 'Advanced options (provider, consensus, strategy, enrich, budgets)?', default: false });
  if (wantsAdvanced) {
    provider = (await select<Provider>({
      message: 'Provider:',
      choices: PROVIDERS.map((p) => ({ value: p })),
      default: provider,
    })) as Provider;
    const summary = currentProviderSummary(provider);
    console.log(`    current: baseUrl=${summary.baseUrl ?? '—'} model=${summary.model ?? '—'} apiKey=${summary.apiKeySet ? 'set' : 'not set'}`);
    const editEndpoint = await confirm({ message: 'Update this provider\'s baseUrl/model/apiKey now? (persists to ~/.config/cleak/config.json, not just this run)', default: false });
    if (editEndpoint) {
      const newBaseUrl = await input({ message: 'baseUrl (blank = keep current):' });
      if (newBaseUrl.trim()) persistEndpointOverride(provider, 'baseUrl', newBaseUrl.trim());
      const newModel = await input({ message: 'model (blank = keep current):' });
      if (newModel.trim()) persistEndpointOverride(provider, 'model', newModel.trim());
      const newApiKey = await password({ message: 'apiKey (blank = keep current):' });
      if (newApiKey.trim()) persistEndpointOverride(provider, 'apiKey', newApiKey.trim());
    }

    if (mode === 'llm_assisted') {
      consensusN = await number({ message: 'Consensus N (1 = single-LLM baseline):', default: consensusN ?? 1, min: 1 });
      if ((consensusN ?? 1) > 1) {
        consensusRule = await select<'majority' | 'weighted' | 'unanimous-to-flag'>({
          message: 'Consensus rule:',
          choices: [{ value: 'majority' }, { value: 'weighted' }, { value: 'unanimous-to-flag' }],
          default: 'weighted',
        });
      }
    }

    strategy = await select<'auto' | 'off'>({
      message: 'Strategy (LLM planner):',
      choices: [{ value: 'off' }, { value: 'auto' }],
      default: strategy ?? 'off',
    });

    if (isRealProjectCorpus(corpus)) {
      console.log('    note: docs/DATASETS.md — --enrich is REQUIRED for a representative recall number on real-project corpora (verified 15.9% → 29.5% on LAMeD).');
    }
    enrich = await confirm({ message: 'Enrich (static enrichment stage)?', default: enrich ?? false });
    toolSelect = await confirm({ message: 'Tool select (agentic tool selection)?', default: toolSelect ?? true });
    staticDiscovery = await confirm({ message: 'Static discovery (static candidate scan)?', default: staticDiscovery ?? true });

    if (enrich) {
      const tools = await checkbox<string>({
        message: 'Static evidence tools (none selected = harness default):',
        choices: [
          { value: 'functionSummary' },
          { value: 'pathConstraints' },
          { value: 'scanBuild' },
          { value: 'interproceduralFlow' },
        ],
      });
      staticTools = tools.length > 0 ? tools : undefined;
    }

    maxCaseMs = await number({ message: 'Max case ms (blank = off / config default):', required: false });
    maxCaseCostUsd = await number({ message: 'Max case cost USD (blank = off / config default):', required: false });

    if (!outDir) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      outDir = await input({ message: 'Out dir:', default: `results/eval-${mode}-${stamp}` });
    }

    runs = await number({ message: 'Runs (>1 activates variance report):', default: runs, min: 1 }) ?? 1;
  }

  if (!outDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    outDir = `results/eval-${mode}-${stamp}`;
  }

  const plan: ResolvedPlan = {
    corpusDir: corpus.outDir,
    mode,
    dynamic,
    outDir,
    limit,
    stratify,
    randomSeed,
    concurrency,
    resume,
    staticUrl: seed.staticUrl,
    dynamicUrl: seed.dynamicUrl,
    runs,
    allowUnvalidated: seed.allowUnvalidated,
    consensusN,
    consensusRule,
    strategy,
    enrich,
    toolSelect,
    staticDiscovery,
    staticTools,
    provider,
    maxCaseMs,
    maxCaseCostUsd,
    verbose: seed.verbose,
  };

  return plan;
}
