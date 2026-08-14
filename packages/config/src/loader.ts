/**
 * Runtime configuration for the TUI/headless runner. All values come from the
 * persisted config file (~/.config/cleak/config.json) with CLI-flag overrides
 * layered on top. Precedence: CLI flag > config file > built-in default.
 */

import type { ConsensusRule } from "./types.js";
import { loadConfigFile } from "./persist.js";
import type { CleakConfig } from "./schema.js";
import type { Provider, ProviderConfig, RunConfig, EnvOverrides } from "./types.js";

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

function readEnvOverrides(): EnvOverrides {
  const out: EnvOverrides = {};
  const e = process.env;
  if (e.LLM_PROVIDER && ["local", "openai", "anthropic", "openai-compat"].includes(e.LLM_PROVIDER)) {
    out.provider = e.LLM_PROVIDER as Provider;
  }
  if (e.STATIC_ANALYZER_MCP_URL) out.staticUrl = e.STATIC_ANALYZER_MCP_URL;
  if (e.DYNAMIC_ANALYZER_MCP_URL) out.dynamicUrl = e.DYNAMIC_ANALYZER_MCP_URL;
  if (e.EVAL_STATIC_URL && !out.staticUrl) out.staticUrl = e.EVAL_STATIC_URL;
  if (e.EVAL_DYNAMIC_URL && !out.dynamicUrl) out.dynamicUrl = e.EVAL_DYNAMIC_URL;
  if (e.RESULTS_DIR) out.resultsDir = e.RESULTS_DIR;
  const llm: Partial<ProviderConfig> = {};
  if (e.OPENAI_COMPAT_BASE_URL) llm.baseUrl = e.OPENAI_COMPAT_BASE_URL;
  if (e.OPENAI_COMPAT_MODEL) llm.model = e.OPENAI_COMPAT_MODEL;
  if (e.OPENAI_COMPAT_API_KEY) llm.apiKey = e.OPENAI_COMPAT_API_KEY;
  if (e.OPENAI_COMPAT_JSON_MODE !== undefined) {
    llm.jsonMode = e.OPENAI_COMPAT_JSON_MODE === "true" || e.OPENAI_COMPAT_JSON_MODE === "1";
  }
  if (Object.keys(llm).length > 0) out.llm = llm;
  if (e.CONSENSUS_N !== undefined) {
    const n = parseInt(e.CONSENSUS_N, 10);
    if (!isNaN(n) && n >= 1) out.consensus = { n };
  }
  return out;
}

function injectEnvIntoFile(file: CleakConfig): CleakConfig {
  const env = readEnvOverrides();
  if (!env.llm) return file;
  const result: CleakConfig = { ...file };
  result.endpoints = { ...file.endpoints };
  const compat = { ...file.endpoints?.["openai-compat"] };
  if (env.llm.baseUrl) compat.baseUrl = env.llm.baseUrl;
  if (env.llm.model) compat.model = env.llm.model;
  if (env.llm.apiKey) compat.apiKey = env.llm.apiKey;
  result.endpoints["openai-compat"] = compat;
  if (env.llm.jsonMode !== undefined) {
    result.llm = { ...file.llm, jsonMode: env.llm.jsonMode };
  }
  return result;
}

/** Resolve the per-provider LLM settings (separate keys so they never collide).
 * Reads tuning from the config file's `llm` block and per-provider `endpoints`. */
export function resolveProvider(provider: Provider, file?: CleakConfig): ProviderConfig {
  const resolvedFile = file ?? injectEnvIntoFile(loadConfigFile());
  const llm = resolvedFile.llm ?? {};
  const ep = (p: Provider): { baseUrl?: string; model?: string; apiKey?: string } => resolvedFile.endpoints?.[p] ?? {};
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
    model: pickStr(e.model, "deepseek-v4-flash-0731"),
    jsonMode: pickBool(llm.jsonMode, true),
    ...common,
  };
}

export function loadConfig(
  overrides: Omit<Partial<RunConfig>, "llm"> & { provider?: Provider; llm?: Partial<ProviderConfig> } = {},
): RunConfig {
  const file = loadConfigFile();
  const env = readEnvOverrides();

  const provider =
    overrides.provider ?? env.provider ?? (pickOpt(file.provider) as Provider | undefined) ?? "local";

  const fileWithEnv = injectEnvIntoFile(file);

  const base: RunConfig = {
    staticUrl: pickStr(env.staticUrl ?? file.staticUrl, "http://localhost:50061/mcp"),
    dynamicUrl: pickStr(env.dynamicUrl ?? file.dynamicUrl, "http://localhost:50062/mcp"),
    provider,
    llm: resolveProvider(provider, fileWithEnv),
    hostRoot: pickOpt(file.hostRoot),
    analyzerRoot: pickOpt(file.analyzerRoot),
    buildCommand: pickOpt(file.buildCommand),
    resultsDir: pickStr(env.resultsDir ?? file.resultsDir, "results"),
    maxTurns: pickNum(file.maxTurns, 15),
    compaction: {
      thresholdTokens: pickNum(file.compaction?.thresholdTokens, 100000),
      keepRecentTurns: pickNum(file.compaction?.keepRecentTurns, 3),
    },
    workflow: {
      staticConcurrency: Math.max(1, pickNum(file.workflow?.staticConcurrency, 3)),
      staticGroupSize: Math.max(1, pickNum(file.workflow?.staticGroupSize, 4)),
      judgeConcurrency: Math.max(1, pickNum(file.workflow?.judgeConcurrency, 3)),
      targetedHarness: {
        // Opt-in: compiles/runs LLM-authored C source (new attack surface) and adds
        // scan cost. Off by default — enable via `cleak config set workflow.targetedHarness.enabled true` or `--harness`.
        enabled: file.workflow?.targetedHarness?.enabled ?? false,
        maxHarnessesPerScan: Math.max(1, pickNum(file.workflow?.targetedHarness?.maxHarnessesPerScan, 5)),
        concurrency: Math.max(1, pickNum(file.workflow?.targetedHarness?.concurrency, 2)),
        timeoutMs: Math.max(1000, pickNum(file.workflow?.targetedHarness?.timeoutMs, 60_000)),
        fuzzBudgetMs: Math.max(1000, pickNum(file.workflow?.targetedHarness?.fuzzBudgetMs, 15_000)),
        maxClosureFiles: Math.max(1, pickNum(file.workflow?.targetedHarness?.maxClosureFiles, 8)),
        verifyConfirmedLeaks: file.workflow?.targetedHarness?.verifyConfirmedLeaks ?? false,
      },
      allocatorVerification: {
        // Opt-in: harness-checks each LLM-proposed allocator/deallocator name.
        // Off by default — enable via `cleak config set workflow.allocatorVerification.enabled true` or `--verify-allocators`.
        enabled: file.workflow?.allocatorVerification?.enabled ?? false,
        maxVerifications: Math.max(1, pickNum(file.workflow?.allocatorVerification?.maxVerifications, 20)),
        concurrency: Math.max(1, pickNum(file.workflow?.allocatorVerification?.concurrency, 2)),
        timeoutMs: Math.max(1000, pickNum(file.workflow?.allocatorVerification?.timeoutMs, 30_000)),
      },
      ownershipVerification: {
        // Opt-in: harness-checks static ownership-transfer claims that would
        // otherwise suppress a leak signal. Off by default — enable via
        // `cleak config set workflow.ownershipVerification.enabled true` or `--verify-ownership`.
        enabled: file.workflow?.ownershipVerification?.enabled ?? false,
        maxVerifications: Math.max(1, pickNum(file.workflow?.ownershipVerification?.maxVerifications, 15)),
        concurrency: Math.max(1, pickNum(file.workflow?.ownershipVerification?.concurrency, 2)),
        timeoutMs: Math.max(1000, pickNum(file.workflow?.ownershipVerification?.timeoutMs, 30_000)),
      },
    },
    consensus: {
      n: Math.max(1, pickNum(file.consensus?.n, 1)),
      rule: parseConsensusRule(pickStr(file.consensus?.rule, "weighted")),
      temperature: pickNum(file.consensus?.temperature, 0.7),
      concurrency: Math.max(1, pickNum(file.consensus?.concurrency, 3)),
    },
    baselines: {
      clangBin: pickStr(file.baselines?.clangBin, "clang"),
      inferBin: pickStr(file.baselines?.inferBin, "infer"),
    },
    evalStaticPathMap: pickOpt(file.eval?.staticPathMap),
    evalMaxCaseMs: pickNum(file.eval?.maxCaseMs, 0),
    evalMaxCaseCostUsd: pickNum(file.eval?.maxCaseCostUsd, 0),
    pricing: file.pricing ?? {},
  };

  if (env.llm?.baseUrl !== undefined) base.llm.baseUrl = env.llm.baseUrl;
  if (env.llm?.model !== undefined) base.llm.model = env.llm.model;
  if (env.llm?.apiKey !== undefined) base.llm.apiKey = env.llm.apiKey;
  if (env.llm?.jsonMode !== undefined) base.llm.jsonMode = env.llm.jsonMode;

  if (env.consensus?.n !== undefined) {
    base.consensus.n = env.consensus.n;
  }

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
      warnings.push(`${label}=${v} is not a number \u2192 ${fallback}`);
      return fallback;
    }
    if (v < min) {
      warnings.push(`${label}=${v} < ${min} \u2192 ${min}`);
      return min;
    }
    if (v > max) {
      warnings.push(`${label}=${v} > ${max} \u2192 ${max}`);
      return max;
    }
    return v;
  };
  cfg.maxTurns = Math.round(clamp("maxTurns", cfg.maxTurns, 1, 200, 15));
  cfg.workflow.staticConcurrency = Math.round(clamp("workflow.staticConcurrency", cfg.workflow.staticConcurrency, 1, 16, 3));
  cfg.workflow.staticGroupSize = Math.round(clamp("workflow.staticGroupSize", cfg.workflow.staticGroupSize, 1, 64, 4));
  cfg.workflow.judgeConcurrency = Math.round(clamp("workflow.judgeConcurrency", cfg.workflow.judgeConcurrency, 1, 16, 3));
  cfg.workflow.targetedHarness.maxHarnessesPerScan = Math.round(
    clamp("workflow.targetedHarness.maxHarnessesPerScan", cfg.workflow.targetedHarness.maxHarnessesPerScan, 1, 50, 5),
  );
  cfg.workflow.targetedHarness.concurrency = Math.round(
    clamp("workflow.targetedHarness.concurrency", cfg.workflow.targetedHarness.concurrency, 1, 8, 2),
  );
  cfg.workflow.targetedHarness.timeoutMs = Math.round(
    clamp("workflow.targetedHarness.timeoutMs", cfg.workflow.targetedHarness.timeoutMs, 1000, 600_000, 60_000),
  );
  cfg.workflow.targetedHarness.fuzzBudgetMs = Math.round(
    clamp("workflow.targetedHarness.fuzzBudgetMs", cfg.workflow.targetedHarness.fuzzBudgetMs, 1000, 120_000, 15_000),
  );
  cfg.workflow.targetedHarness.maxClosureFiles = Math.round(
    clamp("workflow.targetedHarness.maxClosureFiles", cfg.workflow.targetedHarness.maxClosureFiles, 1, 32, 8),
  );
  cfg.workflow.allocatorVerification.maxVerifications = Math.round(
    clamp("workflow.allocatorVerification.maxVerifications", cfg.workflow.allocatorVerification.maxVerifications, 1, 100, 20),
  );
  cfg.workflow.allocatorVerification.concurrency = Math.round(
    clamp("workflow.allocatorVerification.concurrency", cfg.workflow.allocatorVerification.concurrency, 1, 8, 2),
  );
  cfg.workflow.allocatorVerification.timeoutMs = Math.round(
    clamp("workflow.allocatorVerification.timeoutMs", cfg.workflow.allocatorVerification.timeoutMs, 1000, 300_000, 30_000),
  );
  cfg.workflow.ownershipVerification.maxVerifications = Math.round(
    clamp("workflow.ownershipVerification.maxVerifications", cfg.workflow.ownershipVerification.maxVerifications, 1, 100, 15),
  );
  cfg.workflow.ownershipVerification.concurrency = Math.round(
    clamp("workflow.ownershipVerification.concurrency", cfg.workflow.ownershipVerification.concurrency, 1, 8, 2),
  );
  cfg.workflow.ownershipVerification.timeoutMs = Math.round(
    clamp("workflow.ownershipVerification.timeoutMs", cfg.workflow.ownershipVerification.timeoutMs, 1000, 300_000, 30_000),
  );
  cfg.consensus.n = Math.round(clamp("consensus.n", cfg.consensus.n, 1, 9, 1));
  cfg.consensus.temperature = clamp("consensus.temperature", cfg.consensus.temperature, 0, 2, 0.7);
  cfg.consensus.concurrency = Math.round(clamp("consensus.concurrency", cfg.consensus.concurrency, 1, 16, 3));
  // 0 = disabled (no cap) is a valid value for both — min bound is 0, not 1.
  cfg.evalMaxCaseMs = Math.round(clamp("eval.maxCaseMs", cfg.evalMaxCaseMs, 0, 4 * 3600_000, 0));
  cfg.evalMaxCaseCostUsd = clamp("eval.maxCaseCostUsd", cfg.evalMaxCaseCostUsd, 0, 50, 0);
  if (warnings.length) {
    process.stderr.write(`\u26a0 config out of range, clamped:\n${warnings.map((w) => `  - ${w}`).join("\n")}\n`);
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
