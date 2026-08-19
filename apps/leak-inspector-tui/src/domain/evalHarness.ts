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
import { z } from 'zod';
import {
  accumulate,
  computeMetrics,
  calibrationBins,
  expectedCalibrationError,
  bootstrapCI,
  makeRng,
  type Metrics,
  type CalibrationBin,
  type ConfidenceInterval,
  type Sample,
} from '@cleak/common/analysis/metrics';
import { mapWithLimit, buildCallModel } from '@cleak/agent-core';
import type { ConsensusRule } from '@cleak/common/analysis/consensus-judge';
import { QuotaExhaustedError } from '@cleak/common/analysis/judge-shared';
import { countSourceLoc } from '@cleak/common/analysis/harness-utils';
import { EVENT_PHASE, EVENT_KIND, type ScanEventName } from '@cleak/common/flow/scan-flow-contract';
import { runHeadless } from '../surfaces/headless';
import { loadConfig, type RunConfig, toProviderSettings, computeCostUsd } from '@cleak/config';
import { captureProvenance, summarizeStat, type EvalProvenance, type Stat } from './provenance';
import { checkCorpusGate, type CorpusGateResult } from './corpusLock';
import {
  scoreCase,
  isFlagged,
  extraFindings,
  type LabeledCase,
  type LabeledManifest,
  type SnapshotFinding,
  type LabeledFlaw,
  type CleanSite,
  type ExtraFinding,
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
  /** Seeded random sampling (mutually exclusive with `stratify`) — same seed always
   * yields the same subset, so a reported number stays reproducible from the seed
   * alone. See `selectCases`. */
  randomSeed?: number;
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
  /** Stop sampling once the flag/no-flag decision is mathematically locked in
   * (see @cleak/common's isDecisionLocked). Default false — samples all n,
   * unchanged historical behavior. */
  consensusEarlyStop?: boolean;
  /** Judge-verdict disk-cache override. Default (unset) leaves the config value
   * (true). Ablation/stability scripts that intentionally re-judge the SAME
   * evidence across repeat runs should set this `false` — a cache hit would
   * otherwise mask genuine LLM run-to-run variance entirely. */
  judgeCacheEnabled?: boolean;
  /** Stop the run at a case whose LLM judge call hits quota/rate-limit
   * exhaustion instead of silently falling back to the heuristic verdict —
   * see `QuotaExhaustedError` in `@cleak/common/analysis/judge-shared`.
   * Default (unset) leaves the config value (`llm.pauseOnQuotaExhausted`, true). */
  pauseOnQuotaExhausted?: boolean;
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
   * so a sweep can target a known-good gateway without editing global config. A
   * canonical provider type or a named profile (see RunConfig.provider). */
  provider?: string;
  /** Wall-clock deadline per case, ms. Cuts ONLY the offending case (its own
   * AbortController), not the whole run — a runaway real-project case (hundreds of
   * candidates, e.g. LAMeD) no longer blocks the batch indefinitely. Overrides
   * `cleak config`'s `eval.maxCaseMs`; 0/undefined = no cap (default — existing
   * scripts/determinism-gate.sh stay byte-identical unless this is explicitly set). */
  maxCaseMs?: number;
  /** Soft $ cap per case, checked at turn granularity (not instant — mirrors how
   * LiteLLM-style budget enforcement in industrial systems like Atlantis isn't
   * instant either). Overrides `cleak config`'s `eval.maxCaseCostUsd`; 0/undefined =
   * no cap. Only enforceable when pricing is configured for the model (see
   * `computeCostUsd`) — silently a no-op otherwise, same as cost reporting today. */
  maxCaseCostUsd?: number;
  /** Circuit breaker: abort the rest of THIS run after this many consecutive
   * per-case `error` results (real failures — not `skipped`/`budget_exceeded`,
   * which don't necessarily indicate a dead provider). Overrides `cleak config`'s
   * `eval.maxConsecutiveErrors`; 0 = disabled. Cases already in flight when the
   * threshold trips are cut short and marked `circuit_broken`; not-yet-started
   * ones skip immediately with the same status. `EvalResult.circuitBroken` lets
   * callers (`runEvalRepeated`, the baseline sweep) stop early too instead of
   * grinding through a corpus against an exhausted/dead provider. */
  maxConsecutiveErrors?: number;
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

const EvalOptionsSchema = z.object({
  corpusDir: z.string().min(1, 'corpusDir is required'),
  mode: z.enum(['no_llm', 'llm_assisted']),
  dynamic: z.enum(['off', 'selective', 'aggressive']),
  outDir: z.string().min(1),
  limit: z.number().int().positive().optional(),
  stratify: z.string().optional(),
  randomSeed: z.number().int().optional(),
  concurrency: z.number().int().positive().optional(),
  resume: z.boolean().optional(),
  runs: z.number().int().positive().optional(),
  staticUrl: z.string().optional(),
  dynamicUrl: z.string().optional(),
  allowHeuristicFallback: z.boolean().optional(),
  allowUnvalidated: z.boolean().optional(),
  consensusN: z.number().int().positive().optional(),
  consensusRule: z.string().optional(),
  consensusEarlyStop: z.boolean().optional(),
  judgeCacheEnabled: z.boolean().optional(),
  pauseOnQuotaExhausted: z.boolean().optional(),
  strategy: z.enum(['auto', 'off']).optional(),
  enrich: z.boolean().optional(),
  toolSelect: z.boolean().optional(),
  staticDiscovery: z.boolean().optional(),
  staticTools: z.array(z.string()).optional(),
  provider: z.any().optional(),
  maxCaseMs: z.number().nonnegative().optional(),
  maxCaseCostUsd: z.number().nonnegative().optional(),
  maxConsecutiveErrors: z.number().nonnegative().optional(),
  signal: z.any().optional(),
  onProgress: z.function().optional(),
  onCaseStart: z.function().optional(),
  onCasePhase: z.function().optional(),
  onCaseResult: z.function().optional(),
}).strict();

function parseEvalOptions(raw: unknown): EvalOptions {
  return EvalOptionsSchema.parse(raw) as EvalOptions;
}

export interface CaseRow {
  id: string;
  cwe?: string;
  flowVariant?: string;
  functionalVariant?: string;
  /** `budget_exceeded`: the case's own `maxCaseMs`/`maxCaseCostUsd` cap fired — distinct
   * from `error` (a real failure) and `skipped` (run-level cancel) since real cost was
   * spent and partial evidence may exist; see `error` for how much/what cap.
   * `circuit_broken`: the run-wide consecutive-error breaker tripped (see
   * `maxConsecutiveErrors`) — this case was cut short or never started because of
   * OTHER cases' failures, not its own.
   * `quota_exhausted`: THIS case's own LLM judge call hit provider quota/rate-limit
   * exhaustion (see `QuotaExhaustedError`) — trips the breaker immediately
   * (bypassing `maxConsecutiveErrors`) since every subsequent call would fail
   * identically until the quota resets; distinct from `circuit_broken` (a
   * sibling case's failure) and `error` (any other, potentially-transient
   * failure that tolerates `maxConsecutiveErrors` retries first). */
  status: 'ok' | 'error' | 'skipped' | 'budget_exceeded' | 'circuit_broken' | 'quota_exhausted';
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  candidates: number;
  flagged: number;
  /** Count of `extraFindings` — flagged sites matching no labeled ground truth
   * (positive_only corpora only; 0 elsewhere). NOT part of tp/fp/fn/tn — see
   * `evalScoring.ts`'s `extraFindings` doc comment for why. */
  extraFindings: number;
  /** Non-blank source lines in the case (for FP-rate-per-KLOC). */
  loc: number;
  /** Per-case judge-path tally (`llm` / `heuristic` / `consensus`) from verdict_tool. */
  judgePathCounts: Record<string, number>;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Total MCP tool calls (static + dynamic) for this case — efficiency metric. */
  mcpCalls: number;
  /** Count of LLM calls truncated at the token budget (`stopReason === 'max_tokens'`)
   * during this case's investigation phase — a data-quality signal, not a
   * pass/fail one; see `InvestigationOutcome.truncatedCalls`. */
  truncatedCalls: number;
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
  /** True when the consecutive-error circuit breaker tripped during this run
   * (see `EvalOptions.maxConsecutiveErrors`) — the provider looked systemically
   * dead/exhausted rather than the corpus genuinely containing hard cases.
   * `runEvalRepeated` and the baseline sweep check this to stop early instead
   * of repeating/continuing against a still-broken provider. */
  circuitBroken?: boolean;
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
    totalInputTokens: number;
    totalOutputTokens: number;
    meanInputTokens: number;
    meanOutputTokens: number;
    /** Total + mean MCP tool calls across ok cases (efficiency metric). */
    totalMcpCalls: number;
    meanMcpCalls: number;
    /** Sum of `CaseRow.truncatedCalls` across ok cases — nonzero means at least
     * one LLM call was cut off at the token budget during this run. */
    totalTruncatedCalls: number;
    /** Total non-blank source lines scored, and false positives per 1k of them
     * (the LAMeD-style FP-density headline). */
    totalLoc: number;
    fpPerKloc: number;
    /** undefined when no price is configured for `provenance.model` — never $0 as a stand-in. */
    costUsd?: number;
    priced: boolean;
  };
  rows: CaseRow[];
  /** Every per-site classification sample (with `siteId`), so two runs of the same
   * corpus can be aligned site-by-site for a PAIRED McNemar test (`mcnemar-compare`).
   * This is the data the aggregate confusion matrix is built from. */
  samples: Sample[];
  /** Flagged sites outside the labeled ground truth, across all cases (positive_only
   * corpora only — always [] otherwise). NOT scored anywhere above: a real,
   * undocumented leak the tool finds shouldn't be penalized as wrong just because
   * the benchmark's authors didn't catalogue it. For manual/dynamic triage and a
   * separate report section. See `evalScoring.ts`'s `extraFindings` doc comment. */
  extraFindings: (ExtraFinding & { caseId: string })[];
}

interface CachedCase {
  id: string;
  samples: Sample[];
  row: CaseRow;
  /** Snapshot findings retained so --resume can replay the per-case detail view. */
  findings?: SnapshotFinding[];
  /** See `CaseRow.extraFindings` / `EvalResult.extraFindings`. */
  extra?: ExtraFinding[];
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
async function assertLlmAvailable(mode: string, allowFallback?: boolean, provider?: string): Promise<void> {
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
      { cause: err },
    );
  }
}

/**
 * Pick the `limit` cases to evaluate. Default = top-N in manifest order. With
 * `stratifyKey` set, sample EVENLY across that key via deterministic round-robin
 * (round 0 takes one case from every group in sorted-key order, then round 1, …)
 * so a small `limit` still covers every category — Juliet's manifest is grouped by
 * family, so plain top-N is heavily skewed. With `randomSeed` set (and no
 * `stratifyKey` — the two sampling modes are mutually exclusive), shuffle
 * deterministically via `makeRng(seed)` + Fisher-Yates before slicing: this is a
 * THESIS eval tool, so "random" still has to be REPRODUCIBLE from the seed alone,
 * not true nondeterministic randomness. No `limit` ⇒ all cases (order unchanged).
 */
export function selectCases<T extends Record<string, any>>(
  all: T[],
  limit?: number,
  stratifyKey?: string,
  randomSeed?: number,
): T[] {
  if (limit === undefined || limit >= all.length) return all;
  if (randomSeed !== undefined && !stratifyKey) {
    const rng = makeRng(randomSeed);
    const shuffled = all.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, limit);
  }
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
      { cause: err },
    );
  }
}

/**
 * Phase 3: Check the corpus integrity gate. Refuse to run on a corpus with no
 * lockfile, failed validation, or source drift, unless explicitly overridden.
 * When overridden a loud warning is emitted to stderr and the gate result
 * carries the `ok: false` but is returned instead of thrown.
 */
function gateCorpus(corpusDir: string, allowUnvalidated: boolean): CorpusGateResult {
  const gate = checkCorpusGate(corpusDir);
  if (!gate.ok) {
    if (!allowUnvalidated) {
      throw new Error(
        `✗ corpus integrity gate FAILED for ${corpusDir}: ${gate.reason}.\n` +
          `  Run \`tsx scripts/corpus/validate-corpus.ts --corpus ${corpusDir} --write-lock ${corpusDir}.lock.json\` ` +
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
/** Which sampling mode `opts` actually resolves to — mirrors `selectCases`'s own
 * precedence (no limit ⇒ all; random takes priority over stratify if somehow both
 * are set, matching `selectCases`'s `randomSeed && !stratifyKey` guard). */
function samplingProvenance(opts: EvalOptions): EvalProvenance['sampling'] {
  if (opts.limit === undefined) return { mode: 'all' };
  if (opts.randomSeed !== undefined && !opts.stratify) return { mode: 'random', limit: opts.limit, randomSeed: opts.randomSeed };
  if (opts.stratify) return { mode: 'stratified', limit: opts.limit, stratifyKey: opts.stratify };
  return { mode: 'topN', limit: opts.limit };
}

function captureRunProvenance(opts: EvalOptions, _manifest: LabeledManifest, gate: CorpusGateResult): EvalProvenance {
  const llmCfg = opts.mode === 'llm_assisted' ? loadConfig({}).llm : undefined;
  return captureProvenance({
    provider: llmCfg?.provider,
    model: llmCfg?.model,
    temperature: llmCfg?.temperature,
    dynamicEnabled: opts.dynamic !== 'off',
    corpusHash: gate.contentHash,
    corpusValidated: gate.ok,
    runs: opts.runs ?? 1,
    sampling: samplingProvenance(opts),
    ...(opts.mode === 'llm_assisted'
      ? {
          consensus: {
            n: Math.max(1, opts.consensusN ?? 1),
            rule: opts.consensusRule ?? 'weighted',
            ...(opts.consensusEarlyStop !== undefined ? { earlyStop: opts.consensusEarlyStop } : {}),
          },
        }
      : {}),
  });
}

/**
 * Phase 5: Create the per-case cache directory and determine concurrency.
 */
export function prepareCaseCache(outDir: string, concurrencyOverride?: number, _mode?: 'no_llm' | 'llm_assisted'): { cacheDir: string; concurrency: number } {
  const cacheDir = join(outDir, 'cases');
  mkdirSync(cacheDir, { recursive: true });
  // no_llm lowered 6→3 (now matching llm_assisted's existing default): stacked
  // with per-case discoveryConcurrency, the old default put up to 48 concurrent
  // MCP calls on static-analyzer, timing out its largest cases (reproduced:
  // 9/19 MemHint cases at defaults). Stopgap on the caller side;
  // static-analyzer's worker-thread pool fixes the server side.
  const concurrency = concurrencyOverride ?? 3;
  return { cacheDir, concurrency };
}

/**
 * Combine a run-level cancel signal with a case-scoped one: aborted if EITHER
 * fires. Ctrl-C (`opts.signal`) still cancels the whole run; a case's own
 * `maxCaseMs`/`maxCaseCostUsd` timer cuts only that case. Avoids depending on
 * `AbortSignal.any` (newer Node/browser-only API).
 */
function mergeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal {
  const c = new AbortController();
  const abort = () => c.abort();
  if (a?.aborted || b?.aborted) c.abort();
  else {
    a?.addEventListener('abort', abort);
    b?.addEventListener('abort', abort);
  }
  return c.signal;
}

/**
 * Phase 6: Score every case in a concurrency-limited pool. Handles cache replay,
 * cancellation (aborted signal → skipped), per-case progress callbacks, and
 * per-case cache persistence to disk so `--resume` can skip completed cases.
 */
async function scoreCases(
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
  // Resolved once per run: CLI/API override > cleak config > 0 (disabled).
  const evalCfg = loadConfig({ provider: opts.provider });
  const maxCaseMs = opts.maxCaseMs ?? evalCfg.evalMaxCaseMs;
  const maxCaseCostUsd = opts.maxCaseCostUsd ?? evalCfg.evalMaxCaseCostUsd;
  const maxConsecutiveErrors = opts.maxConsecutiveErrors ?? evalCfg.evalMaxConsecutiveErrors;
  // Circuit breaker: tripped once `maxConsecutiveErrors` real `error` results land
  // back-to-back (reset by any `ok`). `breaker` is merged into the run-wide signal so
  // every existing signal.aborted check (early-skip, in-flight case cancellation)
  // picks it up for free — `circuitTripped` only exists to tell a breaker-triggered
  // abort apart from a caller-initiated one when labeling a case's final status.
  const breaker = new AbortController();
  const runSignal = mergeSignals(opts.signal, breaker.signal);
  let consecutiveErrors = 0;
  let circuitTripped = false;
  const tripBreaker = (atCaseId: string, message?: string) => {
    if (circuitTripped) return;
    circuitTripped = true;
    breaker.abort();
    process.stderr.write(
      message ??
        `\n⛔ circuit breaker: ${consecutiveErrors} consecutive case errors (last: ${atCaseId}) — ` +
          `provider looks dead/exhausted. Aborting remaining cases in this run. ` +
          `Re-run with --resume once fixed to pick up where this left off.\n`,
    );
  };
  // Only needed (and only loaded) for a real-time cost cap; report-time cost in
  // aggregateResults() loads pricing separately and is unaffected either way.
  const pricing = maxCaseCostUsd > 0 && opts.mode === 'llm_assisted' ? evalCfg.pricing : undefined;

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
    extraFindings: 0,
    loc: 0,
    judgePathCounts: {},
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    mcpCalls: 0,
    truncatedCalls: 0,
  });

  const scoreOne = async (c: LabeledCase): Promise<CachedCase> => {
    const cachePath = join(cacheDir, `${c.id}.json`);
    if (opts.resume && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as CachedCase;
        // Pre-split-token cache files lack inputTokens/outputTokens — re-run
        // rather than silently report 0 (would understate cost, not just be absent).
        if (typeof cached.row.inputTokens !== 'number' || typeof cached.row.outputTokens !== 'number') {
          throw new Error('stale cache schema (pre-split-tokens)');
        }
        emitResult(c, cached);
        onProgress?.(++done, cases.length, `${c.id} (cached)`);
        return cached;
      } catch {
        /* fall through to re-run */
      }
    }
    // Circuit breaker already tripped by an earlier/concurrent case → skip it,
    // labeled distinctly from a caller-initiated cancel (see CaseRow.status doc).
    if (breaker.signal.aborted) {
      const result: CachedCase = { id: c.id, samples: [], row: { ...skippedRow(c), status: 'circuit_broken' }, findings: [] };
      emitResult(c, result);
      onProgress?.(++done, cases.length, `${c.id} (circuit breaker)`);
      return result;
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
    // Case-scoped budget: a timer aborts ONLY this case's controller (never
    // opts.signal, the run-level one), so a runaway real-project case (hundreds
    // of candidates — e.g. LAMeD) can't block the whole batch. `caseUsage`
    // mirrors the running token total live (via onUsageDelta) so the cost cap
    // can fire mid-scan instead of only after the fact, and so the
    // 'budget_exceeded' row below can report real partial spend, not 0.
    const caseController = new AbortController();
    const caseTimer = maxCaseMs > 0 ? setTimeout(() => caseController.abort(), maxCaseMs) : undefined;
    const caseUsage = { inputTokens: 0, outputTokens: 0 };
    const onUsageDelta = (d: { inputTokens: number; outputTokens: number }) => {
      caseUsage.inputTokens += d.inputTokens;
      caseUsage.outputTokens += d.outputTokens;
      if (maxCaseCostUsd > 0 && !caseController.signal.aborted) {
        // costUsd is undefined when unpriced for this model — a silent no-op cap,
        // same as report-time cost (see computeCostUsd's own contract).
        const { costUsd } = computeCostUsd(caseUsage.inputTokens, caseUsage.outputTokens, evalCfg.llm.model, pricing);
        if (costUsd != null && costUsd > maxCaseCostUsd) caseController.abort();
      }
    };
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
        signal: mergeSignals(runSignal, caseController.signal),
        onUsageDelta,
        ...(opts.strategy ? { strategy: opts.strategy } : {}),
        ...(opts.enrich !== undefined ? { enrich: opts.enrich } : {}),
        ...(opts.toolSelect !== undefined ? { toolSelect: opts.toolSelect } : {}),
        ...(opts.staticDiscovery !== undefined ? { staticDiscovery: opts.staticDiscovery } : {}),
        ...(opts.staticTools ? { staticTools: opts.staticTools } : {}),
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.consensusN != null || opts.consensusRule != null || opts.consensusEarlyStop !== undefined
          ? {
              consensus: {
                ...(opts.consensusN != null ? { n: opts.consensusN } : {}),
                ...(opts.consensusRule ? { rule: opts.consensusRule } : {}),
                ...(opts.consensusEarlyStop !== undefined ? { earlyStop: opts.consensusEarlyStop } : {}),
              },
            }
          : {}),
        ...(opts.judgeCacheEnabled !== undefined ? { judgeCacheEnabled: opts.judgeCacheEnabled } : {}),
        ...(opts.pauseOnQuotaExhausted !== undefined ? { pauseOnQuotaExhausted: opts.pauseOnQuotaExhausted } : {}),
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
      const extra = manifest.positive_only ? extraFindings(findings, c) : [];
      const cm = accumulate(samples);
      const inputTokens = r.usage.inputTokens;
      const outputTokens = r.usage.outputTokens;
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
        extraFindings: extra.length,
        loc: countSourceLoc(repo),
        judgePathCounts,
        durationMs,
        inputTokens,
        outputTokens,
        mcpCalls: r.mcpCalls,
        truncatedCalls: r.truncatedCalls,
        scanId: r.scanId,
      };
      const result: CachedCase = { id: c.id, samples, row, findings, extra };
      writeFileSync(cachePath, JSON.stringify(result));
      emitResult(c, result);
      onProgress?.(++done, cases.length, c.id);
      consecutiveErrors = 0;
      return result;
    } catch (err: unknown) {
      // A case interrupted by cancel counts as skipped (not a real error); a case
      // cut off by its OWN budget cap (not a run-level cancel) is distinct — real
      // cost was spent, so report it instead of a misleading 0. A case cut short by
      // the circuit breaker (this run's OR an in-flight sibling's failures, not this
      // case's own merits) is distinct again. None of the three are cached, so a
      // later --resume re-runs the case.
      // Checked first and independent of abort-signal state — this case's OWN
      // judge call is what threw, not some other case/cap tripping a signal.
      const quotaExhausted = err instanceof QuotaExhaustedError;
      const budgetExceeded = !quotaExhausted && caseController.signal.aborted && !runSignal.aborted;
      const msg = err instanceof Error ? err.message : String(err);
      const circuitBrokenAbort = !quotaExhausted && !budgetExceeded && breaker.signal.aborted;
      const aborted = !quotaExhausted && !budgetExceeded && !circuitBrokenAbort && (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError'));
      const partialMcpCalls = err instanceof Error ? (err as Error & { partialMcpCalls?: number }).partialMcpCalls ?? 0 : 0;
      const spentMs = Date.now() - started;
      const spentCostUsd = budgetExceeded ? computeCostUsd(caseUsage.inputTokens, caseUsage.outputTokens, evalCfg.llm.model, pricing).costUsd : undefined;
      const status: CaseRow['status'] = quotaExhausted
        ? 'quota_exhausted'
        : budgetExceeded
          ? 'budget_exceeded'
          : circuitBrokenAbort
            ? 'circuit_broken'
            : aborted
              ? 'skipped'
              : 'error';
      const row: CaseRow = {
        id: c.id,
        cwe: c.cwe,
        flowVariant: c.flowVariant,
        functionalVariant: c.functionalVariant,
        status,
        tp: 0,
        fp: 0,
        fn: 0,
        tn: 0,
        candidates: 0,
        flagged: 0,
        extraFindings: 0,
        loc: 0,
        judgePathCounts: {},
        durationMs: spentMs,
        inputTokens: budgetExceeded ? caseUsage.inputTokens : 0,
        outputTokens: budgetExceeded ? caseUsage.outputTokens : 0,
        mcpCalls: budgetExceeded ? partialMcpCalls : 0,
        truncatedCalls: 0,
        ...(quotaExhausted
          ? { error: `LLM judge quota/rate-limit exhausted: ${msg}` }
          : budgetExceeded
            ? {
                error:
                  `budget exceeded: spent ${spentMs}ms` +
                  (spentCostUsd != null ? `/$${spentCostUsd.toFixed(2)}` : '') +
                  ` vs cap ${maxCaseMs}ms` +
                  (maxCaseCostUsd > 0 ? `/$${maxCaseCostUsd}` : ''),
              }
            : circuitBrokenAbort
              ? { error: 'circuit breaker: interrupted mid-flight by another case tripping the run' }
              : aborted
                ? {}
                : { error: msg }),
      };
      const result: CachedCase = { id: c.id, samples: [], row, findings: [] };
      emitResult(c, result);
      onProgress?.(++done, cases.length, `${c.id} (${status})`);
      // Only a genuine `error` (this case's own failure, not budget/cancel/breaker)
      // counts toward the breaker — those are the ones a dead provider produces.
      if (status === 'error') {
        consecutiveErrors++;
        if (maxConsecutiveErrors > 0 && consecutiveErrors >= maxConsecutiveErrors) tripBreaker(c.id);
      } else if (status === 'quota_exhausted') {
        // Immediate, unconditional trip — quota exhaustion isn't a flaky blip
        // that might self-resolve on the next case; every subsequent judge
        // call would fail identically until the quota resets, so waiting for
        // maxConsecutiveErrors would just burn more cases for nothing.
        tripBreaker(
          c.id,
          `\n⛔ LLM judge quota/rate-limit exhausted at case ${c.id} — stopping instead of silently ` +
            `falling back to the heuristic (would bias this run vs. others). Re-run with --resume ` +
            `once quota resets. Disable via llm.pauseOnQuotaExhausted=false (or ` +
            `--no-pause-on-quota-exhausted) to allow silent fallback instead.\n`,
        );
      }
      return result;
    } finally {
      clearTimeout(caseTimer);
    }
  };

  return mapWithLimit(cases, concurrency, scoreOne);
}

/**
 * Phase 7: Aggregate per-case scores into the final EvalResult with breakdowns
 * by flow variant, functional variant, and CWE, plus calibration, confidence
 * intervals, judge-path distribution, and cost reporting.
 */
function aggregateResults(cached: CachedCase[], cases: LabeledCase[], opts: EvalOptions, provenance: EvalProvenance, pricing?: RunConfig['pricing']): EvalResult {
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
  const totalInputTokens = okRows.reduce((a, r) => a + r.inputTokens, 0);
  const totalOutputTokens = okRows.reduce((a, r) => a + r.outputTokens, 0);
  const totalTokens = totalInputTokens + totalOutputTokens;
  const totalDuration = okRows.reduce((a, r) => a + r.durationMs, 0);
  const totalLoc = okRows.reduce((a, r) => a + r.loc, 0);
  const totalMcpCalls = okRows.reduce((a, r) => a + (r.mcpCalls ?? 0), 0);
  const totalTruncatedCalls = okRows.reduce((a, r) => a + (r.truncatedCalls ?? 0), 0);

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
    circuitBroken: rows.some((r) => r.status === 'circuit_broken') || undefined,
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
      totalInputTokens,
      totalOutputTokens,
      meanInputTokens: okRows.length ? Math.round(totalInputTokens / okRows.length) : 0,
      meanOutputTokens: okRows.length ? Math.round(totalOutputTokens / okRows.length) : 0,
      totalMcpCalls,
      meanMcpCalls: okRows.length ? Math.round(totalMcpCalls / okRows.length) : 0,
      totalTruncatedCalls,
      totalLoc,
      fpPerKloc: totalLoc > 0 ? (cm.fp / totalLoc) * 1000 : 0,
      ...computeCostUsd(totalInputTokens, totalOutputTokens, provenance.model, pricing),
    },
    rows,
    samples: allSamples,
    extraFindings: cached.flatMap((c) => (c.extra ?? []).map((e) => ({ ...e, caseId: c.id }))),
  };
}

export async function runEval(opts: EvalOptions): Promise<EvalResult> {
  parseEvalOptions(opts); // validate upfront — throws ZodError on invalid input
  // Integrity gate: never let an LLM run quietly degrade to the heuristic baseline.
  await assertLlmAvailable(opts.mode, opts.allowHeuristicFallback, opts.provider);

  const manifest = loadManifest(opts.corpusDir);
  const cases = selectCases(manifest.cases ?? [], opts.limit, opts.stratify, opts.randomSeed);
  const gate = gateCorpus(opts.corpusDir, opts.allowUnvalidated ?? false);
  const provenance = captureRunProvenance(opts, manifest, gate);
  const { cacheDir, concurrency } = prepareCaseCache(opts.outDir, opts.concurrency, opts.mode);
  const cached = await scoreCases(
    cases, opts, manifest, cacheDir, concurrency,
    opts.onProgress, opts.onCaseStart, opts.onCasePhase, opts.onCaseResult,
  );
  // No LLM calls happen in no_llm mode — pricing wouldn't mean anything there.
  const pricing = opts.mode === 'llm_assisted' ? loadConfig({ provider: opts.provider }).pricing : undefined;
  return aggregateResults(cached, cases, opts, provenance, pricing);
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
    // Each run gets its own circuit breaker (fresh AbortController per runEval
    // call) — a trip doesn't carry over automatically, so check explicitly here
    // to stop repeating against a provider that just proved itself dead/exhausted.
    if (result.circuitBroken) break;
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
