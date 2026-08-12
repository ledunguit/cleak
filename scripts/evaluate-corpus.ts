#!/usr/bin/env -S tsx
/**
 * Batch corpus evaluation (v2 harness). Runs the leak-inspector-tui headless
 * scanner over every labeled case in a v2 corpus, scores findings against the
 * per-function / per-line ground truth, and writes the thesis metric artifacts
 * (metrics.json/csv, report.md, tables.tex) via the shared eval harness +
 * reporter. Records reproducibility provenance (model/temperature/tool versions/
 * git commit/corpus hash) and, with --runs>1, mean ± std across independent runs
 * so LLM-sampling variance is reported rather than hidden behind a single pass.
 *
 *   tsx scripts/evaluate-corpus.ts                          # llm_assisted, all cases
 *   tsx scripts/evaluate-corpus.ts no_llm                   # deterministic baseline
 *   tsx scripts/evaluate-corpus.ts llm_assisted --limit 3   # first 3 cases
 *   tsx scripts/evaluate-corpus.ts llm_assisted --runs 5    # 5 runs, report variance
 *   tsx scripts/evaluate-corpus.ts no_llm --dynamic selective --corpus demo/juliet_cwe401
 *
 * In this dev environment the docker stack holds 50061/50062 in gRPC mode, so the
 * MCP analyzers run on 50071/50072; override with EVAL_STATIC_URL / EVAL_DYNAMIC_URL.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { runEval, type EvalResult, type RepeatedEvalResult, type EvalCaseDetail } from '../apps/leak-inspector-tui/src/domain/evalHarness';
import { writeEval } from '../apps/leak-inspector-tui/src/domain/evalReport';
import { captureProvenance, summarizeStat } from '../apps/leak-inspector-tui/src/domain/provenance';
import { loadConfig } from '@cleak/config';

const cfg = loadConfig();

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: tsx scripts/evaluate-corpus.ts [mode] [options]

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
  --out-dir <path>        Explicit output dir — REQUIRED for --resume to find
                           the prior run's cache (otherwise a fresh timestamped
                           dir is created and there is nothing to resume from)
  --concurrency <n>       Parallel case concurrency
  --static-tools <list>   Comma-separated static evidence tools
  --enrich / --no-enrich  Static enrichment stage
  --strategy <auto|off>   LLM strategist
  --tool-select / --no-tool-select  Agentic tool selection
  --static-discovery / --no-static-discovery  Static candidate discovery
  --consensus-n <n>       Consensus samples (default: 1 = single LLM)
  --consensus-rule <rule>  Consensus voting rule
  --max-case-ms <n>       Wall-clock deadline per case, ms (default: 0 = off)
  --max-case-cost-usd <n>  Soft $ cap per case (default: 0 = off)
  --static-url <url>       MCP static analyzer URL
  --dynamic-url <url>      MCP dynamic analyzer URL
  --allow-unvalidated     Bypass corpus integrity gate
  --verbose, -v           Show phase-level detail during scan
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
  verbose: z.boolean().optional(),
  maxCaseMs: z.number().nonnegative().optional(),
  maxCaseCostUsd: z.number().nonnegative().optional(),
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
  const staticUrl = cfg.staticUrl;
  const dynamicUrl = cfg.dynamicUrl;
  // Consensus-judge ablation: n=1 is the single-LLM baseline; n>1 activates
  // multi-agent consensus (llm_assisted only). Falls back to CONSENSUS_N so it can
  // be driven by env too.
  const consensusN = (flag('consensus-n') ?? process.env.CONSENSUS_N)
    ? Math.max(1, parseInt((flag('consensus-n') ?? process.env.CONSENSUS_N)!, 10))
    : cfg.consensus.n > 1 ? cfg.consensus.n : undefined;
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
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

  const maxCaseMs = flag('max-case-ms') ? Math.max(0, parseInt(flag('max-case-ms')!, 10)) : undefined;
  const maxCaseCostUsd = flag('max-case-cost-usd') ? Math.max(0, parseFloat(flag('max-case-cost-usd')!)) : undefined;

  const parsed = CorpusEvalOptionsSchema.parse({
    mode, limit, runs, dynamic, corpusDir, staticUrl, dynamicUrl,
    consensusN, consensusRule, allowUnvalidated, stratify,
    resume, concurrency, staticTools, enrich, strategy,
    toolSelect, staticDiscovery, dryRun, verbose,
    maxCaseMs, maxCaseCostUsd,
  });

  // --resume only has anything to resume FROM if pointed back at the exact
  // prior run's directory — without --out-dir, a fresh timestamped dir is
  // always empty, so --resume silently resumed nothing.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = flag('out-dir') ?? join(cfg.resultsDir, `eval-${parsed.mode}-${stamp}`);
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
    console.log(`  maxCaseMs: ${opts.maxCaseMs ?? 'off (config default)'}`);
    console.log(`  maxCaseCostUsd: ${opts.maxCaseCostUsd ?? 'off (config default)'}`);
    console.log(`  consensusRule: ${opts.consensusRule ?? 'default'}`);
    console.log(`  staticTools: ${opts.staticTools ?? 'default'}`);
    console.log(`  enrich: ${opts.enrich ?? 'default'}`);
    console.log(`  strategy: ${opts.strategy ?? 'default'}`);
    console.log(`  toolSelect: ${opts.toolSelect ?? 'default'}`);
    console.log(`  staticDiscovery: ${opts.staticDiscovery ?? 'default'}`);
    console.log(`  outDir: ${opts.outDir}`);
    console.log(`  verbose: ${opts.verbose}`);
    console.log(`  allowUnvalidated: ${opts.allowUnvalidated}`);
    process.exit(0);
  }

  const baseOpts = { corpusDir: opts.corpusDir, mode: opts.mode, dynamic: opts.dynamic, limit: opts.limit, concurrency: opts.concurrency, resume: opts.resume, stratify: opts.stratify, staticUrl: opts.staticUrl, dynamicUrl: opts.dynamicUrl, consensusN: opts.consensusN, consensusRule: opts.consensusRule, allowUnvalidated: opts.allowUnvalidated, staticTools: opts.staticTools, enrich: opts.enrich, strategy: opts.strategy, toolSelect: opts.toolSelect, staticDiscovery: opts.staticDiscovery, maxCaseMs: opts.maxCaseMs, maxCaseCostUsd: opts.maxCaseCostUsd };
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  let runningTP = 0, runningFP = 0, runningFN = 0, runningTN = 0;
  let runningDone = 0, runningInputTokens = 0, runningOutputTokens = 0, runningMcpCalls = 0;
  let runningOk = 0, runningErr = 0, runningSkp = 0;

  function makeCallbacks(verbose: boolean) {
    runningTP = 0; runningFP = 0; runningFN = 0; runningTN = 0;
    runningDone = 0; runningInputTokens = 0; runningOutputTokens = 0; runningMcpCalls = 0;
    runningOk = 0; runningErr = 0; runningSkp = 0;
    let totalCases = 0;

    const onProgress = (_done: number, total: number, _id: string) => {
      if (totalCases === 0 && total > 0) totalCases = total;
    };

    const onCaseStart = (id: string) => {
      process.stderr.write(`  ▶ ${id} ...\n`);
    };

    const onCasePhase = verbose ? (id: string, phase: string) => {
      process.stderr.write(`    ${id}: ${phase}\n`);
    } : undefined;

    const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);

    const onCaseResult = (detail: EvalCaseDetail) => {
      const r = detail.row;
      runningDone++;
      if (r.status === 'ok') {
        runningOk++;
        runningTP += r.tp; runningFP += r.fp; runningFN += r.fn; runningTN += r.tn;
        runningInputTokens += r.inputTokens ?? 0; runningOutputTokens += r.outputTokens ?? 0; runningMcpCalls += r.mcpCalls ?? 0;
      } else if (r.status === 'error') runningErr++;
      else runningSkp++;

      const jp = r.judgePathCounts
        ? Object.entries(r.judgePathCounts).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] ?? '?'
        : '?';
      const fv = r.functionalVariant ? ` [${r.functionalVariant}]` : '';
      const icon = r.status === 'ok' ? '✓' : r.status === 'error' ? '✗' : '⊘';

      if (r.status === 'ok') {
        const dur = r.durationMs >= 1000
          ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`;
        const tok = `in=${fmtTok(r.inputTokens ?? 0)}/out=${fmtTok(r.outputTokens ?? 0)}`;
        process.stderr.write(
          `  ${icon} ${detail.id}${fv} · TP=${r.tp} FP=${r.fp} FN=${r.fn} TN=${r.tn}` +
          ` · cand=${r.candidates} flg=${r.flagged} · ${dur} · ${r.mcpCalls ?? 0}MCP · ${tok} · ${jp}\n`,
        );
      } else {
        process.stderr.write(`  ${icon} ${detail.id}${fv} · ${r.error ?? 'skipped'}\n`);
      }

      const denom = totalCases || runningDone;
      const sumTok = `in=${fmtTok(runningInputTokens)}/out=${fmtTok(runningOutputTokens)}`;
      process.stderr.write(
        `  ─ ${runningDone}/${denom} · TP=${runningTP} FP=${runningFP} FN=${runningFN} TN=${runningTN}` +
        ` · ∑${sumTok} · ∑${runningMcpCalls}MCP · ${runningOk}ok ${runningErr}err ${runningSkp}skp\n`,
      );
    };

    return { onCaseStart, onCasePhase, onCaseResult, onProgress };
  }

  console.log(`Evaluating corpus=${opts.corpusDir} mode=${opts.mode} dynamic=${opts.dynamic} runs=${opts.runs}${opts.limit ? ` limit=${opts.limit}` : ''}${opts.consensusN ? ` consensus-n=${opts.consensusN}` : ''}\n`);

  if (opts.runs <= 1) {
    const cb = makeCallbacks(opts.verbose);
    const result: EvalResult = await runEval({ ...baseOpts, outDir: opts.outDir, ...cb });
    const files = writeEval(opts.outDir, result);
    const m = result.overall;
    console.log(`\n── ${opts.mode} ── ${result.ranOk}/${result.caseCount} scored`);
    console.log(`  P ${pct(m.precision)} · R ${pct(m.recall)} · F1 ${m.f1.toFixed(3)} · MCC ${m.mcc.toFixed(3)} · ECE ${result.ece.toFixed(3)}`);
    console.log(`  TP ${m.tp} FP ${m.fp} FN ${m.fn} TN ${m.tn}`);
    console.log(`  provenance: model=${result.provenance.model ?? '—'} temp=${result.provenance.temperature ?? '—'} commit=${result.provenance.gitCommit?.slice(0, 8) ?? '—'}`);
    console.log(`\n✓ artifacts: ${files.map((f) => basename(f)).join(', ')} in ${opts.outDir}`);
  } else {
    const perRun: EvalResult[] = [];
    for (let k = 0; k < opts.runs; k++) {
      const runDir = join(opts.outDir, `run-${k + 1}`);
      process.stderr.write(`\n  ── Run ${k + 1}/${opts.runs} ──\n`);
      const cb = makeCallbacks(opts.verbose);
      const result = await runEval({ ...baseOpts, outDir: runDir, ...cb });
      perRun.push(result);
      writeEval(runDir, result);
    }
    const rep: RepeatedEvalResult = {
      runs: perRun.length,
      mode: opts.mode,
      dynamic: opts.dynamic,
      provenance: perRun[0]?.provenance ?? captureProvenance({ dynamicEnabled: opts.dynamic !== 'off', runs: opts.runs }),
      aggregate: {
        precision: summarizeStat(perRun.map((r) => r.overall.precision)),
        recall: summarizeStat(perRun.map((r) => r.overall.recall)),
        f1: summarizeStat(perRun.map((r) => r.overall.f1)),
        accuracy: summarizeStat(perRun.map((r) => r.overall.accuracy)),
        mcc: summarizeStat(perRun.map((r) => r.overall.mcc)),
        ece: summarizeStat(perRun.map((r) => r.ece)),
      },
      perRun,
    };
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
