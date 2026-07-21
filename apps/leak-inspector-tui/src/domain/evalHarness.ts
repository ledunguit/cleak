/**
 * Benchmark evaluation harness. Runs the headless scanner over every labeled
 * case in a v2 corpus, scores each scan's findings against the case's ground
 * truth (evalScoring), and aggregates a confusion matrix into the scientific
 * metrics the thesis reports (Precision/Recall/F1 overall and per flow- /
 * functional-variant), plus confidence calibration and per-mode cost.
 *
 * Built for the full Juliet CWE-401 run: a concurrency pool, a per-case result
 * cache so `--resume` skips completed cases, and partial metrics at any time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accumulate,
  computeMetrics,
  calibrationBins,
  expectedCalibrationError,
  bootstrapCI,
  makeRng,
  type ConfusionMatrix,
  type Metrics,
  type CalibrationBin,
  type ConfidenceInterval,
  type Sample,
} from '@cleak/common/analysis/metrics';
import { mapWithLimit, buildCallModel } from '@cleak/agent-core';
import { toProviderSettings } from '../orchestrator/toolWrappers';
import type { ConsensusRule } from '@cleak/common/analysis/consensus-judge';
import { countSourceLoc } from '@cleak/common/analysis/harness-utils';
import { EVENT_PHASE, EVENT_KIND, type ScanEventName } from '@cleak/common/flow/scan-flow-contract';
import { runHeadless } from '../surfaces/headless';
import { loadConfig, type Provider } from '../config';
import { captureProvenance, summarizeStat, type EvalProvenance, type Stat } from './provenance';
import { checkCorpusGate, type CorpusGateResult } from './corpusLock';
import {
  scoreCase,
  isFlagged,
  type LabeledCase,
  type LabeledManifest,
  type SnapshotFinding,
  type LabeledFlaw,
  type CleanSite,
} from './evalScoring';

/** Per-case detail streamed to the UI so it can show findings vs ground truth. */
export interface EvalCaseDetail {
  id: string;
  row: CaseRow;
  findings: SnapshotFinding[];
  flaws: LabeledFlaw[];
  clean: CleanSite[];
  scanId?: string;
}

export interface EvalOptions {
  corpusDir: string;
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  outDir: string;
  limit?: number;
  /** Stratify the `limit` sample EVENLY across a case key (e.g. `functionalVariant`)
   * instead of taking the top-N in manifest order — Juliet is grouped by family, so
   * top-N is heavily skewed (first 200 are ~90% `char`, 0% of the 672-case `new`
   * family). Deterministic round-robin: representative coverage, reproducible. */
  stratify?: string;
  concurrency?: number;
  resume?: boolean;
  staticUrl?: string;
  dynamicUrl?: string;
  /** Independent repetitions for variance reporting (multi-run); set by runEvalRepeated. */
  runs?: number;
  /**
   * Permit `llm_assisted` to silently fall back to the heuristic judge when no LLM
   * key is configured. Default false: the harness throws up-front so an empty-key
   * run can't masquerade as an LLM ablation (the Δ=0 confound). Opt in only for
   * deliberate "heuristic under llm_assisted plumbing" runs.
   */
  allowHeuristicFallback?: boolean;
  /** Bypass the corpus integrity gate (no lockfile / failed validation / source drift).
   * Loud — the run is stamped `corpus_unvalidated` so a number measured on unverified
   * data can never be mistaken for a trustworthy one. */
  allowUnvalidated?: boolean;
  /** Consensus-judge ablation knobs (only meaningful in llm_assisted mode). n>1
   * activates multi-agent consensus; n=1 (default) is the single-LLM baseline. */
  consensusN?: number;
  consensusRule?: ConsensusRule;
  /** Ablation knobs (baseline sweep): the LLM strategist (planner axis) and the
   * deterministic static-enrichment stage. Both off in the standard eval to keep
   * the Juliet baseline reproducible; the sweep sets them per baseline config. */
  strategy?: 'auto' | 'off';
  enrich?: boolean;
  /** Agentic tool selection (ablation `tool_selector` axis). Default true (current
   * llm_assisted behaviour); false ⇒ deterministic static enrichment + dynamic recipe. */
  toolSelect?: boolean;
  /** Static candidate discovery (ablation `static` axis). Default true; false ⇒
   * dynamic-only discovery (build + LSan → synthesize sites). */
  staticDiscovery?: boolean;
  /** Static evidence tools the enrich stage runs (tool-level ablation). */
  staticTools?: string[];
  /** LLM provider override (eval-scoped) — bypasses the cleak config file's provider
   * so a sweep can target a known-good gateway without editing global config. */
  provider?: Provider;
  /** Cancel the run: in-flight cases are aborted, not-yet-started ones are skipped. */
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, id: string) => void;
  /** A case has started running (before its scan begins). */
  onCaseStart?: (id: string) => void;
  /** A running case advanced to a new phase (live). */
  onCasePhase?: (id: string, phase: string) => void;
  /** A case finished — full detail (findings vs ground truth) for the UI. */
  onCaseResult?: (detail: EvalCaseDetail) => void;
}

export interface CaseRow {
  id: string;
  cwe?: string;
  flowVariant?: string;
  functionalVariant?: string;
  status: 'ok' | 'error' | 'skipped';
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  candidates: number;
  flagged: number;
  /** Non-blank source lines in the case (for FP-rate-per-KLOC). */
  loc: number;
  /** Per-case judge-path tally (`llm` / `heuristic` / `consensus`) from verdict_tool. */
  judgePathCounts: Record<string, number>;
  durationMs: number;
  tokens: number;
  /** Total MCP tool calls (static + dynamic) for this case — efficiency metric. */
  mcpCalls: number;
  scanId?: string;
  error?: string;
}

export interface EvalResult {
  corpus: string;
  mode: string;
  dynamic: string;
  generatedAt: string;
  /** Unix milliseconds (machine-parseable counterpart to generatedAt). */
  generatedAtMs: number;
  /** Model/provider/temperature/tool-versions/git-commit/corpus-hash for reproducibility. */
  provenance: EvalProvenance;
  caseCount: number;
  ranOk: number;
  overall: Metrics;
  byFlowVariant: Record<string, Metrics>;
  byFunctionalVariant: Record<string, Metrics>;
  byCwe: Record<string, Metrics>;
  calibration: CalibrationBin[];
  ece: number;
  /** 95% percentile-bootstrap confidence intervals on the headline metrics (seeded,
   * reproducible). The sampling-uncertainty companion to the across-run variance. */
  overallCI: { precision: ConfidenceInterval; recall: ConfidenceInterval; f1: ConfidenceInterval };
  /** Which judge decided the verdicts, aggregated across cases. In `llm_assisted`
   * mode a healthy run is dominated by `llm`; a heuristic-heavy distribution means
   * the LLM silently fell back (integrity signal). */
  judgePathDistribution: Record<string, number>;
  cost: {
    cases: number;
    meanDurationMs: number;
    totalTokens: number;
    meanTokens: number;
    /** Total + mean MCP tool calls across ok cases (efficiency metric). */
    totalMcpCalls: number;
    meanMcpCalls: number;
    /** Total non-blank source lines scored, and false positives per 1k of them
     * (the LAMeD-style FP-density headline). */
    totalLoc: number;
    fpPerKloc: number;
  };
  rows: CaseRow[];
  /** Every per-site classification sample (with `siteId`), so two runs of the same
   * corpus can be aligned site-by-site for a PAIRED McNemar test (`mcnemar-compare`).
   * This is the data the aggregate confusion matrix is built from. */
  samples: Sample[];
}

interface CachedCase {
  id: string;
  samples: Sample[];
  row: CaseRow;
  /** Snapshot findings retained so --resume can replay the per-case detail view. */
  findings?: SnapshotFinding[];
}

function metricsByKey(groups: Map<string, Sample[]>): Record<string, Metrics> {
  const out: Record<string, Metrics> = {};
  for (const [key, samples] of [...groups.entries()].sort()) out[key] = computeMetrics(accumulate(samples));
  return out;
}

/** The env var that supplies the API key for each provider (for clear errors). */
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  local: 'LOCAL_LLM_API_KEY',
  'openai-compat': 'OPENAI_COMPAT_API_KEY',
};

/**
 * Guard against the silent `llm_assisted == no_llm` confound: if an LLM run is
 * requested but no key is configured for a cloud provider, throw BEFORE any case
 * runs. (A keyless `local` gateway is legitimate, so it's allowed through; the
 * post-run assertion in `runEval` still catches a dead local gateway.)
 */
async function assertLlmAvailable(mode: string, allowFallback?: boolean, provider?: Provider): Promise<void> {
  if (mode !== 'llm_assisted' || allowFallback) return;
  const full = loadConfig(provider ? { provider } : {});
  const cfg = full.llm;
  // A custom OpenAI-compatible endpoint needs a base URL + model; a key is often
  // optional (many local servers accept none), so check completeness, not the key.
  if (cfg.provider === 'openai-compat' && (!cfg.baseUrl || !cfg.model)) {
    throw new Error(
      `llm_assisted with provider 'openai-compat' needs a base URL AND a model ` +
        `(set OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_MODEL, or --base-url/--model). ` +
        `Got baseUrl='${cfg.baseUrl}', model='${cfg.model}'.`,
    );
  }
  // local + openai-compat gateways may legitimately be keyless.
  const keyOptional = cfg.provider === 'local' || cfg.provider === 'openai-compat';
  if (!cfg.apiKey && !keyOptional) {
    const env = PROVIDER_KEY_ENV[cfg.provider] ?? 'the provider API key';
    throw new Error(
      `llm_assisted requested but no API key for provider '${cfg.provider}' (set ${env}). ` +
        `Results would silently fall back to the heuristic judge (Δ=0 vs no_llm). ` +
        `Fix the key, or pass allowHeuristicFallback / --allow-heuristic-fallback to run anyway.`,
    );
  }
  // LIVE health-check: a non-empty key/url is NOT enough — a wrong base URL or a down
  // gateway returns HTML/errors and EVERY case silently falls back to the heuristic
  // (the exact bug that made a whole n=200 run heuristic-only). One tiny completion
  // proves the endpoint actually answers; fail LOUD if it doesn't.
  process.stderr.write(`  llm health-check: provider=${cfg.provider} @ ${cfg.baseUrl} model=${cfg.model} …\n`);
  try {
    const callModel = buildCallModel(toProviderSettings(full), () => globalThis.crypto.randomUUID());
    await callModel({ systemPrompt: 'health check', messages: [{ role: 'user', content: 'reply ok' }], tools: [], temperature: 0 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `llm_assisted health-check FAILED for provider '${cfg.provider}' @ ${cfg.baseUrl} (model ${cfg.model}): ` +
        `${msg}. The gateway is unreachable/misconfigured — every case would silently fall back ` +
        `to the heuristic (Δ=0 confound). Fix the endpoint (e.g. --provider local), or pass --allow-heuristic-fallback.`,
    );
  }
}

/**
 * Pick the `limit` cases to evaluate. Default = top-N in manifest order. With
 * `stratifyKey` set, sample EVENLY across that key via deterministic round-robin
 * (round 0 takes one case from every group in sorted-key order, then round 1, …)
 * so a small `limit` still covers every category — Juliet's manifest is grouped by
 * family, so plain top-N is heavily skewed. No `limit` ⇒ all cases (order unchanged).
 */
export function selectCases<T extends Record<string, any>>(all: T[], limit?: number, stratifyKey?: string): T[] {
  if (limit === undefined || limit >= all.length) return all;
  if (!stratifyKey) return all.slice(0, limit);
  const groups = new Map<string, T[]>();
  for (const c of all) {
    const k = String(c[stratifyKey] ?? '?');
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const buckets = [...groups.keys()].sort().map((k) => groups.get(k)!);
  const out: T[] = [];
  for (let round = 0; out.length < limit; round++) {
    let progressed = false;
    for (const b of buckets) {
      if (round < b.length) {
        out.push(b[round]);
        progressed = true;
        if (out.length >= limit) break;
      }
    }
    if (!progressed) break;
  }
  return out;
}

// ── Phase functions ──────────────────────────────────────────────────

/**
 * Phase 1: Read and parse the corpus manifest.
 * @throws Descriptive error when the manifest is missing or unparseable.
 */
export function loadManifest(corpusDir: string): LabeledManifest {
  const manifestPath = join(corpusDir, 'corpus_manifest.json');
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as LabeledManifest;
  } catch (err) {
    throw new Error(
      `Failed to parse corpus manifest at '${manifestPath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Phase 3: Check the corpus integrity gate. Refuse to run on a corpus with no
 * lockfile, failed validation, or source drift, unless explicitly overridden.
 * When overridden a loud warning is emitted to stderr and the gate result
 * carries the `ok: false` but is returned instead of thrown.
 */
export function gateCorpus(corpusDir: string, allowUnvalidated: boolean): CorpusGateResult {
  const gate = checkCorpusGate(corpusDir);
  if (!gate.ok) {
    if (!allowUnvalidated) {
      throw new Error(
        `✗ corpus integrity gate FAILED for ${corpusDir}: ${gate.reason}.\n` +
          `  Run \`bun scripts/corpus/validate-corpus.ts --corpus ${corpusDir} --write-lock ${corpusDir}.lock.json\` ` +
          `and commit the lockfile, or pass --allow-unvalidated to run on UNVERIFIED data.`,
      );
    }
    process.stderr.write(
      `⚠ corpus UNVALIDATED (${gate.reason}) — running anyway (--allow-unvalidated); numbers are NOT trustworthy.\n`,
    );
  }
  return gate;
}

/**
 * Phase 4: Capture reproducibility provenance — the exact config that produced
 * these numbers (provider, model, temperature, corpus hash, consensus settings).
 */
export function captureRunProvenance(opts: EvalOptions, _manifest: LabeledManifest, gate: CorpusGateResult): EvalProvenance {
  const llmCfg = opts.mode === 'llm_assisted' ? loadConfig({}).llm : undefined;
  return captureProvenance({
    provider: llmCfg?.provider,
    model: llmCfg?.model,
    temperature: llmCfg?.temperature,
    dynamicEnabled: opts.dynamic !== 'off',
    corpusHash: gate.contentHash,
    corpusValidated: gate.ok,
    runs: opts.runs ?? 1,
    ...(opts.mode === 'llm_assisted'
      ? { consensus: { n: Math.max(1, opts.consensusN ?? 1), rule: opts.consensusRule ?? 'weighted' } }
      : {}),
  });
}

/**
 * Phase 5: Create the per-case cache directory and determine concurrency.
 */
export function prepareCaseCache(outDir: string, concurrencyOverride?: number, mode?: 'no_llm' | 'llm_assisted'): { cacheDir: string; concurrency: number } {
  const cacheDir = join(outDir, 'cases');
  mkdirSync(cacheDir, { recursive: true });
  const concurrency = concurrencyOverride ?? (mode === 'no_llm' ? 6 : 3);
  return { cacheDir, concurrency };
}

/**
 * Phase 6: Score every case in a concurrency-limited pool. Handles cache replay,
 * cancellation (aborted signal → skipped), per-case progress callbacks, and
 * per-case cache persistence to disk so `--resume` can skip completed cases.
 */
export async function scoreCases(
  cases: LabeledCase[],
  opts: EvalOptions,
  manifest: LabeledManifest,
  cacheDir: string,
  concurrency: number,
  onProgress?: (done: number, total: number, id: string) => void,
  onCaseStart?: (id: string) => void,
  onCasePhase?: (id: string, phase: string) => void,
  onCaseResult?: (detail: EvalCaseDetail) => void,
): Promise<CachedCase[]> {
  let done = 0;

  const emitResult = (c: LabeledCase, cached: CachedCase) => {
    onCaseResult?.({
      id: c.id,
      row: cached.row,
      findings: cached.findings ?? [],
      flaws: c.flaws ?? [],
      clean: c.clean ?? [],
      scanId: cached.row.scanId,
    });
  };

  const skippedRow = (c: LabeledCase): CaseRow => ({
    id: c.id,
    cwe: c.cwe,
    flowVariant: c.flowVariant,
    functionalVariant: c.functionalVariant,
    status: 'skipped',
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    candidates: 0,
    flagged: 0,
    loc: 0,
    judgePathCounts: {},
    durationMs: 0,
    tokens: 0,
    mcpCalls: 0,
  });

  const scoreOne = async (c: LabeledCase): Promise<CachedCase> => {
    const cachePath = join(cacheDir, `${c.id}.json`);
    if (opts.resume && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as CachedCase;
        emitResult(c, cached);
        onProgress?.(++done, cases.length, `${c.id} (cached)`);
        return cached;
      } catch {
        /* fall through to re-run */
      }
    }
    // Cancelled before this case got a worker → skip it.
    if (opts.signal?.aborted) {
      const result: CachedCase = { id: c.id, samples: [], row: skippedRow(c), findings: [] };
      emitResult(c, result);
      onProgress?.(++done, cases.length, `${c.id} (skipped)`);
      return result;
    }
    const repo = join(opts.corpusDir, c.repo_path);
    const started = Date.now();
    onCaseStart?.(c.id);
    try {
      const r = await runHeadless({
        repo,
        mode: opts.mode,
        dynamic: opts.dynamic,
        format: 'snapshot',
        build: c.build_command,
        // Per-project allocators: the case's own list wins, else the corpus default.
        extraAllocators: c.allocators ?? manifest.allocators,
        extraDeallocators: c.deallocators ?? manifest.deallocators,
        staticUrl: opts.staticUrl,
        dynamicUrl: opts.dynamicUrl,
        quiet: true,
        signal: opts.signal,
        ...(opts.strategy ? { strategy: opts.strategy } : {}),
        ...(opts.enrich !== undefined ? { enrich: opts.enrich } : {}),
        ...(opts.toolSelect !== undefined ? { toolSelect: opts.toolSelect } : {}),
        ...(opts.staticDiscovery !== undefined ? { staticDiscovery: opts.staticDiscovery } : {}),
        ...(opts.staticTools ? { staticTools: opts.staticTools } : {}),
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.consensusN != null || opts.consensusRule != null
          ? { consensus: { ...(opts.consensusN != null ? { n: opts.consensusN } : {}), ...(opts.consensusRule ? { rule: opts.consensusRule } : {}) } }
          : {}),
        // Stream phase transitions so the UI can show each case's live progress.
        onEvent: onCasePhase
          ? (ev) => {
              if (EVENT_KIND[ev.name as ScanEventName] === 'phase_start') {
                const phase = EVENT_PHASE[ev.name as ScanEventName] ?? ev.phase;
                if (phase) onCasePhase!(c.id, String(phase));
              }
            }
          : undefined,
      });
      const durationMs = Date.now() - started;
      const snapshot = JSON.parse(readFileSync(join(r.dir, 'snapshot.json'), 'utf-8')) as { findings?: SnapshotFinding[] };
      // Fail LOUDLY on a malformed snapshot: a missing findings array would
      // otherwise score the case as 0 candidates / all-FN and silently bias the
      // metrics. Better to mark the case `error` (the catch below) than lie.
      if (!Array.isArray(snapshot.findings)) {
        throw new Error(`snapshot.json for ${c.id} has no findings array (got ${typeof snapshot.findings})`);
      }
      const findings = snapshot.findings;
      const samples = scoreCase(findings, c);
      const cm = accumulate(samples);
      const tokens = (r.investigation?.usage?.inputTokens ?? 0) + (r.investigation?.usage?.outputTokens ?? 0);
      // Per-case judge-path tally from verdict_tool (only for findings that were
      // actually flagged — those are the verdicts whose provenance matters).
      const judgePathCounts: Record<string, number> = {};
      for (const f of findings) {
        if (isFlagged(f.verdict) && f.verdict_tool) judgePathCounts[f.verdict_tool] = (judgePathCounts[f.verdict_tool] ?? 0) + 1;
      }
      const row: CaseRow = {
        id: c.id,
        cwe: c.cwe,
        flowVariant: c.flowVariant,
        functionalVariant: c.functionalVariant,
        status: 'ok',
        tp: cm.tp,
        fp: cm.fp,
        fn: cm.fn,
        tn: cm.tn,
        candidates: findings.length,
        flagged: findings.filter((f) => isFlagged(f.verdict)).length,
        loc: countSourceLoc(repo),
        judgePathCounts,
        durationMs,
        tokens,
        mcpCalls: r.mcpCalls,
        scanId: r.scanId,
      };
      const result: CachedCase = { id: c.id, samples, row, findings };
      writeFileSync(cachePath, JSON.stringify(result));
      emitResult(c, result);
      onProgress?.(++done, cases.length, c.id);
      return result;
    } catch (err: unknown) {
      // A case interrupted by cancel counts as skipped (not a real error), and is
      // NOT cached so a later --resume re-runs it.
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      const row: CaseRow = {
        id: c.id,
        cwe: c.cwe,
        flowVariant: c.flowVariant,
        functionalVariant: c.functionalVariant,
        status: aborted ? 'skipped' : 'error',
        tp: 0,
        fp: 0,
        fn: 0,
        tn: 0,
        candidates: 0,
        flagged: 0,
        loc: 0,
        judgePathCounts: {},
        durationMs: Date.now() - started,
        tokens: 0,
        mcpCalls: 0,
        ...(aborted ? {} : { error: msg }),
      };
      const result: CachedCase = { id: c.id, samples: [], row, findings: [] };
      emitResult(c, result);
      onProgress?.(++done, cases.length, `${c.id} (${aborted ? 'skipped' : 'error'})`);
      return result;
    }
  };

  return mapWithLimit(cases, concurrency, scoreOne);
}

/**
 * Phase 7: Aggregate per-case scores into the final EvalResult with breakdowns
 * by flow variant, functional variant, and CWE, plus calibration, confidence
 * intervals, judge-path distribution, and cost reporting.
 */
export function aggregateResults(cached: CachedCase[], cases: LabeledCase[], opts: EvalOptions, provenance: EvalProvenance): EvalResult {
  const allSamples: Sample[] = [];
  const byFlow = new Map<string, Sample[]>();
  const byFunc = new Map<string, Sample[]>();
  const byCwe = new Map<string, Sample[]>();
  const push = (m: Map<string, Sample[]>, k: string | undefined, s: Sample[]) => {
    const key = k || 'unknown';
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(...s);
  };
  for (let i = 0; i < cached.length; i++) {
    const { samples } = cached[i];
    const c = cases[i];
    allSamples.push(...samples);
    push(byFlow, c.flowVariant, samples);
    push(byFunc, c.functionalVariant, samples);
    push(byCwe, c.cwe, samples);
  }

  const rows = cached.map((c) => c.row);
  const okRows = rows.filter((r) => r.status === 'ok');
  const totalTokens = okRows.reduce((a, r) => a + r.tokens, 0);
  const totalDuration = okRows.reduce((a, r) => a + r.durationMs, 0);
  const totalLoc = okRows.reduce((a, r) => a + r.loc, 0);
  const totalMcpCalls = okRows.reduce((a, r) => a + (r.mcpCalls ?? 0), 0);

  // Which judge actually decided the flagged verdicts, across all ok cases.
  const judgePathDistribution: Record<string, number> = {};
  for (const r of okRows) {
    for (const [tool, n] of Object.entries(r.judgePathCounts)) {
      judgePathDistribution[tool] = (judgePathDistribution[tool] ?? 0) + n;
    }
  }
  // Integrity signal: an llm_assisted run that produced ZERO llm/consensus verdicts
  // is AMBIGUOUS — either the LLM never fired (dead gateway / bad key, the silent-
  // fallback confound) OR the heuristic was confident on every case so nothing was
  // borderline enough to escalate (legitimate). We can't distinguish here (the
  // harness doesn't see escalation attempts), so WARN loudly rather than throw; the
  // recorded judgePathDistribution lets the reader see the truth. The deterministic
  // guard against a misconfigured provider is the up-front assertLlmAvailable().
  if (opts.mode === 'llm_assisted' && okRows.length > 0) {
    const llmVerdicts = (judgePathDistribution['llm'] ?? 0) + (judgePathDistribution['consensus'] ?? 0);
    if (llmVerdicts === 0) {
      process.stderr.write(
        `\n⚠️  llm_assisted produced 0 LLM/consensus verdicts across ${okRows.length} cases ` +
          `(judge paths: ${JSON.stringify(judgePathDistribution)}). Either nothing was borderline ` +
          `(heuristic confident — fine) or the LLM never fired (dead gateway/key — these numbers are ` +
          `the heuristic baseline mislabeled). Verify the provider/gateway before trusting an LLM Δ.\n`,
      );
    }
  }

  const cm = accumulate(allSamples);
  // Seeded so the reported interval is reproducible across re-aggregations.
  const ci = (sel: (m: Metrics) => number) => bootstrapCI(allSamples, (c) => sel(computeMetrics(c)), { iters: 1000, rng: makeRng(0xc0ffee) });

  return {
    corpus: opts.corpusDir,
    mode: opts.mode,
    dynamic: opts.dynamic,
    generatedAt: new Date().toISOString(),
    generatedAtMs: Date.now(),
    provenance,
    caseCount: cases.length,
    ranOk: okRows.length,
    overall: computeMetrics(cm),
    byFlowVariant: metricsByKey(byFlow),
    byFunctionalVariant: metricsByKey(byFunc),
    byCwe: metricsByKey(byCwe),
    calibration: calibrationBins(allSamples, 10),
    ece: expectedCalibrationError(allSamples, 10),
    overallCI: { precision: ci((m) => m.precision), recall: ci((m) => m.recall), f1: ci((m) => m.f1) },
    judgePathDistribution,
    cost: {
      cases: okRows.length,
      meanDurationMs: okRows.length ? Math.round(totalDuration / okRows.length) : 0,
      totalTokens,
      meanTokens: okRows.length ? Math.round(totalTokens / okRows.length) : 0,
      totalMcpCalls,
      meanMcpCalls: okRows.length ? Math.round(totalMcpCalls / okRows.length) : 0,
      totalLoc,
      fpPerKloc: totalLoc > 0 ? (cm.fp / totalLoc) * 1000 : 0,
    },
    rows,
    samples: allSamples,
  };
}

export async function runEval(opts: EvalOptions): Promise<EvalResult> {
  // Integrity gate: never let an LLM run quietly degrade to the heuristic baseline.
  await assertLlmAvailable(opts.mode, opts.allowHeuristicFallback, opts.provider);

  const manifest = loadManifest(opts.corpusDir);
  const cases = selectCases(manifest.cases ?? [], opts.limit, opts.stratify);
  const gate = gateCorpus(opts.corpusDir, opts.allowUnvalidated ?? false);
  const provenance = captureRunProvenance(opts, manifest, gate);
  const { cacheDir, concurrency } = prepareCaseCache(opts.outDir, opts.concurrency, opts.mode);
  const cached = await scoreCases(
    cases, opts, manifest, cacheDir, concurrency,
    opts.onProgress, opts.onCaseStart, opts.onCasePhase, opts.onCaseResult,
  );
  return aggregateResults(cached, cases, opts, provenance);
}

/** Aggregate of N independent eval runs: headline metric mean ± std across runs. */
export interface RepeatedEvalResult {
  runs: number;
  mode: string;
  dynamic: string;
  provenance: EvalProvenance;
  /** Mean/std/min/max across runs for the headline metrics + ECE. */
  aggregate: Record<'precision' | 'recall' | 'f1' | 'accuracy' | 'mcc' | 'ece', Stat>;
  perRun: EvalResult[];
}

/**
 * Run the whole eval `runs` times and report mean ± std of the headline metrics.
 * LLM sampling is nondeterministic, so a single `llm_assisted` pass is a point
 * estimate; reporting variance across runs is what makes the comparison credible.
 * Each run writes to its own `outDir/run-K` so per-case caches never collide.
 * For deterministic `no_llm` mode one run suffices (callers should pass runs=1).
 */
export async function runEvalRepeated(opts: EvalOptions, runs: number): Promise<RepeatedEvalResult> {
  const n = Math.max(1, Math.floor(runs));
  const perRun: EvalResult[] = [];
  for (let k = 0; k < n; k++) {
    if (opts.signal?.aborted) break;
    const result = await runEval({ ...opts, outDir: join(opts.outDir, `run-${k + 1}`), runs: n });
    perRun.push(result);
    opts.onProgress?.(k + 1, n, `run ${k + 1}/${n}`);
  }
  const pick = (sel: (m: Metrics) => number) => summarizeStat(perRun.map((r) => sel(r.overall)));
  return {
    runs: perRun.length,
    mode: opts.mode,
    dynamic: opts.dynamic,
    provenance: perRun[0]?.provenance ?? captureProvenance({ dynamicEnabled: opts.dynamic !== 'off', runs: n }),
    aggregate: {
      precision: pick((m) => m.precision),
      recall: pick((m) => m.recall),
      f1: pick((m) => m.f1),
      accuracy: pick((m) => m.accuracy),
      mcc: pick((m) => m.mcc),
      ece: summarizeStat(perRun.map((r) => r.ece)),
    },
    perRun,
  };
}
