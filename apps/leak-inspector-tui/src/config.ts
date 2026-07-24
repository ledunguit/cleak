/**
 * Runtime configuration for the TUI/headless runner. All values come from the
 * persisted config file (~/.config/cleak/config.json) with CLI-flag overrides
 * layered on top. Precedence: CLI flag > config file > built-in default.
 */

import type { ConsensusRule } from "@cleak/common/analysis/consensus-judge";
import { loadConfigFile, type CleakConfig } from "./domain/config-file";

export type Provider = "local" | "openai" | "anthropic" | "openai-compat";
export type AnalysisModeOpt = "no_llm" | "llm_assisted";
export type DynamicModeOpt = "off" | "selective" | "aggressive";

/** Multi-agent consensus judging knobs (the thesis novelty). n=1 ⇒ the single-LLM
 * judge (default), so consensus is strictly opt-in and the single-LLM path is the
 * unchanged regression baseline. */
export interface ConsensusJudgeConfig {
  n: number;
  rule: ConsensusRule;
  temperature: number;
  concurrency: number;
}

export interface ProviderConfig {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  jsonMode: boolean;
  /** Pinned sampling temperature (default 0 for reproducible runs). */
  temperature: number;
  /** Temperature for the judge role specifically — deterministic verdicts. */
  judgeTemperature: number;
  timeoutMs: number;
  /** Max silence between streamed chunks before the request is treated as hung. */
  idleTimeoutMs: number;
  /** Time-to-first-byte budget when connecting. */
  connectTimeoutMs: number;
  retries: number;
  maxTokens: number;
}

export interface ThresholdsConfig {
  borderlineLow: number;
  borderlineHigh: number;
}

export interface BaselinesConfig {
  clangBin: string;
  inferBin: string;
}

export interface RunConfig {
  staticUrl: string;
  dynamicUrl: string;
  provider: Provider;
  llm: ProviderConfig;
  /** Path translation between host paths and analyzer-visible paths. */
  hostRoot?: string;
  analyzerRoot?: string;
  resultsDir: string;
  maxTurns: number;
  /** Auto-compaction thresholds for the agent transcript. */
  compaction: { thresholdTokens: number; keepRecentTurns: number };
  /** Staged-workflow investigation knobs (bounded to protect the single LLM gateway). */
  workflow: { staticConcurrency: number; staticGroupSize: number; judgeConcurrency: number; discoveryConcurrency: number };
  /** Consensus judge (self-consistency) configuration for the borderline judge stage. */
  consensus: ConsensusJudgeConfig;
  /** Judge confidence thresholds. */
  thresholds: ThresholdsConfig;
  /** External baseline tool paths. */
  baselines: BaselinesConfig;
  /** Eval-time host→container path remapping (format: "from=to"). */
  evalStaticPathMap?: string;
}

// Layered resolution: config-file value > built-in default. CLI-flag overrides
// are applied on top in loadConfig(), so the full precedence is
// CLI flag > config file > default.
function pickStr(fileVal: string | undefined, fallback: string): string {
  if (fileVal !== undefined && fileVal !== "") return fileVal;
  return fallback;
}

function pickOpt(fileVal: string | undefined): string | undefined {
  if (fileVal !== undefined && fileVal !== "") return fileVal;
  return undefined;
}

function pickNum(fileVal: number | undefined, fallback: number): number {
  if (fileVal !== undefined) return fileVal;
  return fallback;
}

function pickBool(fileVal: boolean | undefined, fallback: boolean): boolean {
  if (fileVal !== undefined) return fileVal;
  return fallback;
}

/** Resolve the per-provider LLM settings (separate keys so they never collide).
 * Reads tuning from the config file's `llm` block and per-provider `endpoints`. */
export function resolveProvider(provider: Provider, file: CleakConfig = loadConfigFile()): ProviderConfig {
  const llm = file.llm ?? {};
  const ep = (p: Provider): { baseUrl?: string; model?: string; apiKey?: string } => file.endpoints?.[p] ?? {};
  const timeoutMs = pickNum(llm.timeoutMs, 75000);
  // Streaming path: an *idle* gap timer (no bytes for this long = hung), not a
  // total deadline — so a model that keeps emitting tokens is never killed.
  const idleTimeoutMs = pickNum(llm.idleTimeoutMs, pickNum(llm.timeoutMs, 75000));
  const connectTimeoutMs = pickNum(llm.connectTimeoutMs, 30000);
  const retries = pickNum(llm.retries, 2);
  const maxTokens = pickNum(llm.maxTokens, 4096);
  // Pin temperature for reproducibility (default 0). The judge stays deterministic
  // even if the agentic loop is bumped up for exploration.
  const temperature = pickNum(llm.temperature, 0);
  const judgeTemperature = pickNum(llm.judgeTemperature, 0);
  const common = { temperature, judgeTemperature, timeoutMs, idleTimeoutMs, connectTimeoutMs, retries, maxTokens };
  if (provider === "openai") {
    const e = ep("openai");
    return {
      provider,
      baseUrl: pickStr(e.baseUrl, "https://api.openai.com/v1"),
      apiKey: pickStr(e.apiKey, ""),
      model: pickStr(e.model, "gpt-4o"),
      jsonMode: pickBool(llm.jsonMode, true),
      ...common,
    };
  }
  if (provider === "anthropic") {
    const e = ep("anthropic");
    return {
      provider,
      baseUrl: pickStr(e.baseUrl, "https://api.anthropic.com"),
      apiKey: pickStr(e.apiKey, ""),
      model: pickStr(e.model, "claude-sonnet-4-20250514"),
      jsonMode: false,
      ...common,
    };
  }
  if (provider === "openai-compat") {
    // Any OpenAI-compatible server (LM Studio, vLLM, Ollama, OpenRouter, a private
    // gateway). No api.openai.com default — the base URL/model are user-supplied
    // (config file / CLI). Routes through the OpenAI chat path.
    const e = ep("openai-compat");
    return {
      provider,
      baseUrl: pickStr(e.baseUrl, ""),
      apiKey: pickStr(e.apiKey, ""),
      model: pickStr(e.model, ""),
      jsonMode: pickBool(llm.jsonMode, true),
      ...common,
    };
  }
  // local OpenAI-compatible gateway (thesis default)
  const e = ep("local");
  return {
    provider: "local",
    baseUrl: pickStr(e.baseUrl, "http://localhost:20128/v1"),
    apiKey: pickStr(e.apiKey, ""),
    model: pickStr(e.model, "mimo/mimo-v2.5-pro"),
    jsonMode: pickBool(llm.jsonMode, true),
    ...common,
  };
}

export function loadConfig(
  overrides: Omit<Partial<RunConfig>, "llm"> & { provider?: Provider; llm?: Partial<ProviderConfig> } = {},
): RunConfig {
  // Read the persisted config file once.
  const file = loadConfigFile();
  const provider =
    overrides.provider ?? (pickOpt(file.provider) as Provider | undefined) ?? "local";
  const base: RunConfig = {
    staticUrl: pickStr(file.staticUrl, "http://localhost:50061/mcp"),
    dynamicUrl: pickStr(file.dynamicUrl, "http://localhost:50062/mcp"),
    provider,
    llm: resolveProvider(provider, file),
    hostRoot: pickOpt(file.hostRoot),
    analyzerRoot: pickOpt(file.analyzerRoot),
    resultsDir: pickStr(file.resultsDir, "results"),
    maxTurns: pickNum(file.maxTurns, 15),
    compaction: {
      thresholdTokens: pickNum(file.compaction?.thresholdTokens, 100000),
      keepRecentTurns: pickNum(file.compaction?.keepRecentTurns, 3),
    },
    workflow: {
      // Bounded: many concurrent sub-agents would overload a single local gateway.
      staticConcurrency: Math.max(1, pickNum(file.workflow?.staticConcurrency, 3)),
      staticGroupSize: Math.max(1, pickNum(file.workflow?.staticGroupSize, 4)),
      judgeConcurrency: Math.max(1, pickNum(file.workflow?.judgeConcurrency, 3)),
      discoveryConcurrency: Math.max(1, pickNum(file.workflow?.discoveryConcurrency, 8)),
    },
    consensus: {
      // n=1 ⇒ single-LLM judge (default). The eval ablation bumps this to 3/5.
      n: Math.max(1, pickNum(file.consensus?.n, 1)),
      rule: parseConsensusRule(pickStr(file.consensus?.rule, "weighted")),
      // Sampling diversity for self-consistency: >0 so the N samples differ.
      temperature: pickNum(file.consensus?.temperature, 0.7),
      concurrency: Math.max(1, pickNum(file.consensus?.concurrency, 3)),
    },
    thresholds: {
      borderlineLow: pickNum(file.thresholds?.borderlineLow, 0.35),
      borderlineHigh: pickNum(file.thresholds?.borderlineHigh, 0.7),
    },
    baselines: {
      clangBin: pickStr(file.baselines?.clangBin, "clang"),
      inferBin: pickStr(file.baselines?.inferBin, "infer"),
    },
    evalStaticPathMap: pickOpt(file.eval?.staticPathMap),
  };
  // Apply only DEFINED overrides so an absent flag (e.g. --provider) never
  // clobbers a resolved value with undefined. `consensus` and `llm` are merged
  // FIELD-WISE so a partial override (just `n`, or just `model`) keeps the rest of
  // the resolved block instead of replacing the whole object.
  const { consensus: consensusOverride, llm: llmOverride, ...rest } = overrides;
  const defined = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  );
  const merged: RunConfig = { ...base, ...defined };
  if (consensusOverride) {
    merged.consensus = { ...base.consensus, ...pruneUndefined(consensusOverride) };
  }
  if (llmOverride) {
    merged.llm = { ...base.llm, ...pruneUndefined(llmOverride) };
  }
  return clampConfig(merged);
}

/**
 * Hard bounds so a stray env var or CLI flag (e.g. `CONSENSUS_N=1000`, a negative
 * temperature, `WORKFLOW_STATIC_CONCURRENCY=500`) cannot spawn a runaway fan-out
 * that floods the gateway, or pass an out-of-range sampling temperature to the
 * provider. Out-of-range / non-numeric values are CLAMPED (not fatal) with a
 * one-line stderr warning, so the run still proceeds with safe values. Exported
 * for unit testing.
 */
export function clampConfig(cfg: RunConfig): RunConfig {
  const warnings: string[] = [];
  const clamp = (label: string, v: number, min: number, max: number, fallback: number): number => {
    if (!Number.isFinite(v)) {
      warnings.push(`${label}=${v} is not a number → ${fallback}`);
      return fallback;
    }
    if (v < min) {
      warnings.push(`${label}=${v} < ${min} → ${min}`);
      return min;
    }
    if (v > max) {
      warnings.push(`${label}=${v} > ${max} → ${max}`);
      return max;
    }
    return v;
  };
  cfg.maxTurns = Math.round(clamp("maxTurns", cfg.maxTurns, 1, 200, 15));
  cfg.workflow.staticConcurrency = Math.round(clamp("workflow.staticConcurrency", cfg.workflow.staticConcurrency, 1, 16, 3));
  cfg.workflow.staticGroupSize = Math.round(clamp("workflow.staticGroupSize", cfg.workflow.staticGroupSize, 1, 64, 4));
  cfg.workflow.judgeConcurrency = Math.round(clamp("workflow.judgeConcurrency", cfg.workflow.judgeConcurrency, 1, 16, 3));
  cfg.consensus.n = Math.round(clamp("consensus.n", cfg.consensus.n, 1, 9, 1));
  cfg.consensus.temperature = clamp("consensus.temperature", cfg.consensus.temperature, 0, 2, 0.7);
  cfg.consensus.concurrency = Math.round(clamp("consensus.concurrency", cfg.consensus.concurrency, 1, 16, 3));
  if (warnings.length) {
    process.stderr.write(`⚠ config out of range, clamped:\n${warnings.map((w) => `  - ${w}`).join("\n")}\n`);
  }
  return cfg;
}

const CONSENSUS_RULES: ReadonlySet<string> = new Set(["majority", "weighted", "unanimous-to-flag"]);
function parseConsensusRule(v: string): ConsensusRule {
  return (CONSENSUS_RULES.has(v) ? v : "weighted") as ConsensusRule;
}

/** Drop undefined-valued keys so a partial override never clobbers a default. */
function pruneUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
