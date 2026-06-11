/**
 * Runtime configuration for the TUI/headless runner. All values come from env
 * (matching the control-plane's variable names so a single .env drives both)
 * with CLI-flag overrides layered on top.
 */

export type Provider = "local" | "openai" | "anthropic";
export type AnalysisModeOpt = "no_llm" | "llm_assisted";
export type DynamicModeOpt = "off" | "selective" | "aggressive";

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
  workflow: { staticConcurrency: number; staticGroupSize: number; judgeConcurrency: number };
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v !== "false" && v !== "0";
}

/**
 * The shared .env points the local gateway at `host.docker.internal` (reachable
 * from inside a container). When the TUI runs on the host, rewrite it to
 * localhost. Set IN_CONTAINER=1 to keep the container hostname.
 */
function hostAwareUrl(url: string): string {
  if (process.env.IN_CONTAINER) return url;
  return url.replace("host.docker.internal", "localhost");
}

/** Resolve the per-provider LLM settings (separate keys so they never collide). */
export function resolveProvider(provider: Provider): ProviderConfig {
  const timeoutMs = Number(env("LLM_TIMEOUT_MS", "75000"));
  // Streaming path: an *idle* gap timer (no bytes for this long = hung), not a
  // total deadline — so a model that keeps emitting tokens is never killed.
  const idleTimeoutMs = Number(env("LLM_IDLE_TIMEOUT_MS", env("LLM_TIMEOUT_MS", "75000")));
  const connectTimeoutMs = Number(env("LLM_CONNECT_TIMEOUT_MS", "30000"));
  const retries = Number(env("LLM_RETRIES", "2"));
  const maxTokens = Number(env("LLM_MAX_TOKENS", "4096"));
  // Pin temperature for reproducibility (default 0). The judge stays deterministic
  // even if the agentic loop is bumped up for exploration.
  const temperature = Number(env("LLM_TEMPERATURE", "0"));
  const judgeTemperature = Number(env("JUDGE_LLM_TEMPERATURE", "0"));
  if (provider === "openai") {
    return {
      provider,
      baseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
      apiKey: env("OPENAI_API_KEY"),
      model: env("OPENAI_MODEL", "gpt-4o"),
      jsonMode: bool("OPENAI_JSON_MODE", true),
      temperature,
      judgeTemperature,
      timeoutMs,
      idleTimeoutMs,
      connectTimeoutMs,
      retries,
      maxTokens,
    };
  }
  if (provider === "anthropic") {
    return {
      provider,
      baseUrl: env("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
      apiKey: env("ANTHROPIC_API_KEY"),
      model: env("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
      jsonMode: false,
      temperature,
      judgeTemperature,
      timeoutMs,
      idleTimeoutMs,
      connectTimeoutMs,
      retries,
      maxTokens,
    };
  }
  // local OpenAI-compatible gateway (thesis default)
  return {
    provider: "local",
    baseUrl: hostAwareUrl(env("LOCAL_LLM_BASE_URL", "http://localhost:20128/v1")),
    apiKey: env("LOCAL_LLM_API_KEY"),
    model: env("LOCAL_LLM_MODEL", "mimo/mimo-v2.5-pro"),
    jsonMode: bool("LOCAL_LLM_JSON_MODE", true),
    temperature,
    judgeTemperature,
    timeoutMs,
    idleTimeoutMs,
    connectTimeoutMs,
    retries,
    maxTokens,
  };
}

export function loadConfig(
  overrides: Partial<RunConfig> & { provider?: Provider } = {},
): RunConfig {
  const provider =
    overrides.provider ?? (env("LLM_PROVIDER", "local") as Provider);
  const base: RunConfig = {
    staticUrl: hostAwareUrl(env("STATIC_ANALYZER_MCP_URL", "http://localhost:50061/mcp")),
    dynamicUrl: hostAwareUrl(env("DYNAMIC_ANALYZER_MCP_URL", "http://localhost:50062/mcp")),
    provider,
    llm: resolveProvider(provider),
    hostRoot: env("HOST_ROOT") || undefined,
    analyzerRoot: env("ANALYZER_ROOT") || undefined,
    resultsDir: env("RESULTS_DIR", "results"),
    maxTurns: Number(env("AGENT_MAX_TURNS", "15")),
    compaction: {
      thresholdTokens: Number(env("LLM_COMPACT_THRESHOLD_TOKENS", "100000")),
      keepRecentTurns: Number(env("LLM_COMPACT_KEEP_TURNS", "3")),
    },
    workflow: {
      // Bounded: many concurrent sub-agents would overload a single local gateway.
      staticConcurrency: Math.max(1, Number(env("WORKFLOW_STATIC_CONCURRENCY", "3"))),
      staticGroupSize: Math.max(1, Number(env("WORKFLOW_STATIC_GROUP_SIZE", "4"))),
      judgeConcurrency: Math.max(1, Number(env("WORKFLOW_JUDGE_CONCURRENCY", "3"))),
    },
  };
  // Apply only DEFINED overrides so an absent flag (e.g. --provider) never
  // clobbers a resolved value with undefined.
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return { ...base, ...defined };
}
