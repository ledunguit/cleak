#!/usr/bin/env bun
/**
 * Batch corpus evaluation (v2 harness). Runs the leak-inspector-tui headless
 * scanner over every labeled case in a v2 corpus, scores findings against the
 * per-function / per-line ground truth, and writes the thesis metric artifacts
 * (metrics.json/csv, report.md, tables.tex) via the shared eval harness +
 * reporter. Records reproducibility provenance (model/temperature/tool versions/
 * git commit/corpus hash) and, with --runs>1, mean ± std across independent runs
 * so LLM-sampling variance is reported rather than hidden behind a single pass.
 *
 *   bun scripts/evaluate-corpus.ts                          # llm_assisted, all cases
 *   bun scripts/evaluate-corpus.ts no_llm                   # deterministic baseline
 *   bun scripts/evaluate-corpus.ts llm_assisted --limit 3   # first 3 cases
 *   bun scripts/evaluate-corpus.ts llm_assisted --runs 5    # 5 runs, report variance
 *   bun scripts/evaluate-corpus.ts no_llm --dynamic selective --corpus demo/juliet_cwe401
 *
 * In this dev environment the docker stack holds 50061/50062 in gRPC mode, so the
 * MCP analyzers run on 50071/50072; override with EVAL_STATIC_URL / EVAL_DYNAMIC_URL.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { runEval, runEvalRepeated, type EvalResult, type RepeatedEvalResult } from '../apps/leak-inspector-tui/src/domain/evalHarness';
import { writeEval } from '../apps/leak-inspector-tui/src/domain/evalReport';
import { loadEnvFiles } from '../apps/leak-inspector-tui/src/domain/env';

loadEnvFiles();

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: bun scripts/evaluate-corpus.ts [mode] [options]

Evaluate the leak-inspector-tui over a labeled corpus.

Mode:
  no_llm               Deterministic heuristic (default: llm_assisted)

Options:
  --corpus <dir>          Corpus directory (default: demo/juliet_cwe401)
  --limit <n>             Only evaluate first N cases
  --runs <n>              Run N times and report variance (default: 1)
  --dynamic <off|selective|aggressive>  Dynamic analysis mode
  --stratify [key]        Stratify sample evenly across case key
  --resume                Resume previous eval (per-case cache)
  --concurrency <n>       Parallel case concurrency
  --static-tools <list>   Comma-separated static evidence tools
  --enrich / --no-enrich  Static enrichment stage
  --strategy <auto|off>   LLM strategist
  --tool-select / --no-tool-select  Agentic tool selection
  --static-discovery / --no-static-discovery  Static candidate discovery
  --consensus-n <n>       Consensus samples (default: 1 = single LLM)
  --consensus-rule <rule>  Consensus voting rule
  --static-url <url>       MCP static analyzer URL
  --dynamic-url <url>      MCP dynamic analyzer URL
  --allow-unvalidated     Bypass corpus integrity gate
  --dry-run               Print config and exit
  --help, -h              Show this help`);
  process.exit(0);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const CorpusEvalOptionsSchema = z.object({
  mode: z.enum(['no_llm', 'llm_assisted']).default('llm_assisted'),
  limit: z.number().int().positive().optional(),
  runs: z.number().int().min(1).default(1),
  dynamic: z.enum(['off', 'selective', 'aggressive']).default('off'),
  corpusDir: z.string().default('demo/juliet_cwe401'),
  staticUrl: z.string().default('http://127.0.0.1:50071/mcp'),
  dynamicUrl: z.string().default('http://127.0.0.1:50072/mcp'),
  consensusN: z.number().int().min(1).optional(),
  consensusRule: z.enum(['majority', 'weighted', 'unanimous-to-flag']).optional(),
  allowUnvalidated: z.boolean().default(false),
  stratify: z.string().optional(),
  resume: z.boolean().default(false),
  concurrency: z.number().int().min(1).optional(),
  staticTools: z.array(z.string()).optional(),
  enrich: z.boolean().optional(),
  strategy: z.enum(['auto', 'off']).optional(),
  toolSelect: z.boolean().optional(),
  staticDiscovery: z.boolean().optional(),
  dryRun: z.boolean().default(false),
}).passthrough();

type CorpusEvalOptions = z.infer<typeof CorpusEvalOptionsSchema> & { outDir: string };

function parseCorpusArgs(): CorpusEvalOptions {
  const mode = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'llm_assisted') as
    | 'no_llm'
    | 'llm_assisted';
  const limit = flag('limit') ? parseInt(flag('limit')!, 10) : undefined;
  const runs = flag('runs') ? Math.max(1, parseInt(flag('runs')!, 10)) : 1;
  const dynamic = (flag('dynamic') as 'off' | 'selective' | 'aggressive') ?? 'off';
  const corpusDir = flag('corpus') ?? process.env.CORPUS_DIR ?? 'demo/juliet_cwe401';
  const staticUrl = process.env.EVAL_STATIC_URL ?? 'http://127.0.0.1:50071/mcp';
  const dynamicUrl = process.env.EVAL_DYNAMIC_URL ?? 'http://127.0.0.1:50072/mcp';
  // Consensus-judge ablation: n=1 is the single-LLM baseline; n>1 activates
  // multi-agent consensus (llm_assisted only). Falls back to CONSENSUS_N so it can
  // be driven by env too.
  const consensusN = (flag('consensus-n') ?? process.env.CONSENSUS_N)
    ? Math.max(1, parseInt((flag('consensus-n') ?? process.env.CONSENSUS_N)!, 10))
    : undefined;
  const consensusRule = flag('consensus-rule') as 'majority' | 'weighted' | 'unanimous-to-flag' | undefined;

  const allowUnvalidated = process.argv.includes('--allow-unvalidated');

  // --- Ablation / sweep flags ---
  const stratifyVal = flag('stratify');
  const hasStratify = process.argv.includes('--stratify');
  const stratify = hasStratify
    ? !stratifyVal || stratifyVal.startsWith('--')
      ? 'functionalVariant'
      : stratifyVal
    : undefined;

  const resume = process.argv.includes('--resume');

  const concurrency = flag('concurrency') ? Math.max(1, parseInt(flag('concurrency')!, 10)) : undefined;

  const staticToolsRaw = flag('static-tools');
  const staticTools = staticToolsRaw === undefined ? undefined
    : staticToolsRaw === 'none' || staticToolsRaw === '' ? []
    : staticToolsRaw.split(',').map(s => s.trim()).filter(Boolean);

  const enrich = process.argv.includes('--enrich') ? true
    : process.argv.includes('--no-enrich') ? false
    : undefined;

  const strategy = flag('strategy') as 'auto' | 'off' | undefined;

  const toolSelect = process.argv.includes('--tool-select') ? true
    : process.argv.includes('--no-tool-select') ? false
    : undefined;

  const staticDiscovery = process.argv.includes('--static-discovery') ? true
    : process.argv.includes('--no-static-discovery') ? false
    : undefined;

  const dryRun = process.argv.includes('--dry-run');

  const parsed = CorpusEvalOptionsSchema.parse({
    mode, limit, runs, dynamic, corpusDir, staticUrl, dynamicUrl,
    consensusN, consensusRule, allowUnvalidated, stratify,
    resume, concurrency, staticTools, enrich, strategy,
    toolSelect, staticDiscovery, dryRun,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(process.env.RESULTS_DIR ?? 'results', `eval-${parsed.mode}-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  return { ...parsed, outDir };
}

export async function main(): Promise<void> {
  const opts = parseCorpusArgs();

  // --- Dry run ---
  if (opts.dryRun) {
    console.log(`DRY RUN — evaluate-corpus.ts`);
    console.log(`  corpus: ${opts.corpusDir}`);
    console.log(`  mode: ${opts.mode}`);
    console.log(`  dynamic: ${opts.dynamic}`);
    console.log(`  limit: ${opts.limit ?? 'all'}`);
    console.log(`  runs: ${opts.runs}`);
    console.log(`  stratify: ${opts.stratify ?? 'none'}`);
    console.log(`  resume: ${opts.resume}`);
    console.log(`  concurrency: ${opts.concurrency ?? 'auto'}`);
    console.log(`  staticUrl: ${opts.staticUrl}`);
    console.log(`  dynamicUrl: ${opts.dynamicUrl}`);
    console.log(`  consensusN: ${opts.consensusN ?? 'default'}`);
    console.log(`  consensusRule: ${opts.consensusRule ?? 'default'}`);
    console.log(`  staticTools: ${opts.staticTools ?? 'default'}`);
    console.log(`  enrich: ${opts.enrich ?? 'default'}`);
    console.log(`  strategy: ${opts.strategy ?? 'default'}`);
    console.log(`  toolSelect: ${opts.toolSelect ?? 'default'}`);
    console.log(`  staticDiscovery: ${opts.staticDiscovery ?? 'default'}`);
    console.log(`  outDir: ${opts.outDir}`);
    console.log(`  allowUnvalidated: ${opts.allowUnvalidated}`);
    process.exit(0);
  }

  const baseOpts = { corpusDir: opts.corpusDir, mode: opts.mode, dynamic: opts.dynamic, limit: opts.limit, concurrency: opts.concurrency, resume: opts.resume, stratify: opts.stratify, staticUrl: opts.staticUrl, dynamicUrl: opts.dynamicUrl, consensusN: opts.consensusN, consensusRule: opts.consensusRule, allowUnvalidated: opts.allowUnvalidated, staticTools: opts.staticTools, enrich: opts.enrich, strategy: opts.strategy, toolSelect: opts.toolSelect, staticDiscovery: opts.staticDiscovery };
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  console.log(`Evaluating corpus=${opts.corpusDir} mode=${opts.mode} dynamic=${opts.dynamic} runs=${opts.runs}${opts.limit ? ` limit=${opts.limit}` : ''}${opts.consensusN ? ` consensus-n=${opts.consensusN}` : ''}\n`);

  if (opts.runs <= 1) {
    const result: EvalResult = await runEval({ ...baseOpts, outDir: opts.outDir });
    const files = writeEval(opts.outDir, result);
    const m = result.overall;
    console.log(`\n── ${opts.mode} ── ${result.ranOk}/${result.caseCount} scored`);
    console.log(`  P ${pct(m.precision)} · R ${pct(m.recall)} · F1 ${m.f1.toFixed(3)} · MCC ${m.mcc.toFixed(3)} · ECE ${result.ece.toFixed(3)}`);
    console.log(`  TP ${m.tp} FP ${m.fp} FN ${m.fn} TN ${m.tn}`);
    console.log(`  provenance: model=${result.provenance.model ?? '—'} temp=${result.provenance.temperature ?? '—'} commit=${result.provenance.gitCommit?.slice(0, 8) ?? '—'}`);
    console.log(`\n✓ artifacts: ${files.map((f) => basename(f)).join(', ')} in ${opts.outDir}`);
  } else {
    const rep: RepeatedEvalResult = await runEvalRepeated({ ...baseOpts, outDir: opts.outDir }, opts.runs);
    for (let i = 0; i < rep.perRun.length; i++) writeEval(join(opts.outDir, `run-${i + 1}`), rep.perRun[i]);
    writeFileSync(join(opts.outDir, 'variance.json'), JSON.stringify(rep, null, 2));
    writeFileSync(join(opts.outDir, 'variance.md'), varianceMarkdown(rep));
    const a = rep.aggregate;
    const pm = (s: { mean: number; std: number }) => `${(s.mean * 100).toFixed(1)}% ± ${(s.std * 100).toFixed(1)}`;
    console.log(`\n── ${opts.mode} · ${rep.runs} runs (mean ± std) ──`);
    console.log(`  P ${pm(a.precision)} · R ${pm(a.recall)} · F1 ${a.f1.mean.toFixed(3)} ± ${a.f1.std.toFixed(3)}`);
    console.log(`  MCC ${a.mcc.mean.toFixed(3)} ± ${a.mcc.std.toFixed(3)} · ECE ${a.ece.mean.toFixed(3)} ± ${a.ece.std.toFixed(3)}`);
    console.log(`\n✓ variance.json + per-run artifacts in ${opts.outDir}`);
  }
}

function varianceMarkdown(rep: RepeatedEvalResult): string {
  const a = rep.aggregate;
  const row = (label: string, s: { mean: number; std: number; min: number; max: number }) =>
    `| ${label} | ${s.mean.toFixed(3)} | ${s.std.toFixed(3)} | ${s.min.toFixed(3)} | ${s.max.toFixed(3)} |`;
  const p = rep.provenance;
  return [
    `# Variance report — ${rep.mode}${rep.dynamic !== 'off' ? ` +dynamic(${rep.dynamic})` : ''} · ${rep.runs} runs`,
    '',
    `- Model: ${p.model ?? '— (no_llm)'} · temperature ${p.temperature ?? '—'} · provider ${p.provider ?? '—'}`,
    `- Git commit: ${p.gitCommit ?? '—'} · corpus hash: ${p.corpusHash ?? '—'}`,
    '',
    '| metric | mean | std | min | max |',
    '|---|--:|--:|--:|--:|',
    row('Precision', a.precision),
    row('Recall', a.recall),
    row('F1', a.f1),
    row('Accuracy', a.accuracy),
    row('MCC', a.mcc),
    row('ECE', a.ece),
    '',
  ].join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) { await main(); }
