import type { ConsensusRule } from "@cleak/common/analysis/consensus-judge";
export type { ConsensusRule };

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
  /** Stop sampling once the flag/no-flag decision is mathematically locked in (see
   * @cleak/common's isDecisionLocked). Default false — samples all n, unchanged. */
  earlyStop: boolean;
}

/** Disk-persisted, content-hash-keyed cache of LLM judge verdicts under
 * `<repo>/.cleak/judge-cache/` — skips the LLM entirely (including every
 * consensus sample) for a bundle whose evidence is byte-identical to a
 * previously-judged one. Default ON: correctness rests on the cache key
 * covering everything that affects the prompt (see judgeVerdictCache.ts),
 * not on being opt-in — same default posture as the static-analyzer's AST
 * cache. */
export interface JudgeCacheConfig {
  enabled: boolean;
  maxEntries: number;
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
  /** When a judge call fails because the provider's quota/rate-limit is
   * exhausted, stop the run at that case instead of silently falling back to
   * the heuristic verdict (which would mislabel a degraded run as
   * LLM-assisted). Default true — matches the codebase's existing "fail loud"
   * posture (see `assertLlmAvailable`/`--allow-heuristic-fallback`). */
  pauseOnQuotaExhausted: boolean;
}

export interface BaselinesConfig {
  clangBin: string;
  inferBin: string;
}

export interface TargetedHarnessConfig {
  enabled: boolean;
  maxHarnessesPerScan: number;
  concurrency: number;
  timeoutMs: number;
  fuzzBudgetMs: number;
  maxClosureFiles: number;
  /** Widen Stage B2 to ALSO target confident CONFIRMED_LEAK verdicts, not just
   * borderline ones — a double-check, not a new mechanism (same harness worker,
   * same cap). A clean result routes to the LLM/consensus judge automatically via
   * `shouldEscalate`'s existing `dynamicRanClean` check — no other code involved. */
  verifyConfirmedLeaks: boolean;
}

/** Dynamic verification of the LLM-discovered allocator/deallocator profile
 * (harness-check each candidate instead of trusting textual grep-verify alone). */
export interface AllocatorVerificationConfig {
  enabled: boolean;
  maxVerifications: number;
  concurrency: number;
  timeoutMs: number;
}

/** Dynamic verification of static ownership-transfer claims (harness-check
 * whether a function really does hand out / consume heap ownership as claimed,
 * instead of trusting the AST-lexical `ownershipCarrier` guess alone). */
export interface OwnershipVerificationConfig {
  enabled: boolean;
  maxVerifications: number;
  concurrency: number;
  timeoutMs: number;
}

export interface RunConfig {
  staticUrl: string;
  dynamicUrl: string;
  /** Which named endpoint profile was selected (a canonical provider type, or a
   * custom name like "deepseek-direct") — display/traceability only. The actual
   * transport to call is always `llm.provider` (strict, resolved). */
  provider: string;
  llm: ProviderConfig;
  /** Path translation between host paths and analyzer-visible paths. */
  hostRoot?: string;
  analyzerRoot?: string;
  /** Default build command for the deterministic dynamic recipe; empty/absent keeps
   * dynamic staging off unless the per-run CLI flag provides one. */
  buildCommand?: string;
  resultsDir: string;
  maxTurns: number;
  /** Auto-compaction thresholds for the agent transcript. */
  compaction: { thresholdTokens: number; keepRecentTurns: number };
  /** Staged-workflow investigation knobs (bounded to protect the single LLM gateway). */
  workflow: {
    staticConcurrency: number;
    staticGroupSize: number;
    judgeConcurrency: number;
    /** Stage B2 — targeted per-candidate harness synthesis (opt-in, off by default:
     * compiles/runs LLM-authored C source, new attack surface + extra cost). */
    targetedHarness: TargetedHarnessConfig;
    /** Dynamic verification of profileAllocators' candidate names (opt-in, off by
     * default — same harness infra, different verification target). */
    allocatorVerification: AllocatorVerificationConfig;
    /** Dynamic verification of static ownership-transfer claims (opt-in, off by
     * default — same harness infra, different verification target). */
    ownershipVerification: OwnershipVerificationConfig;
  };
  /** Consensus judge (self-consistency) configuration for the borderline judge stage. */
  consensus: ConsensusJudgeConfig;
  /** LLM judge-verdict disk cache — see JudgeCacheConfig. */
  judgeCache: JudgeCacheConfig;
  /** External baseline tool paths. */
  baselines: BaselinesConfig;
  /** Eval-time host→container path remapping (format: "from=to"). */
  evalStaticPathMap?: string;
  /** Wall-clock deadline per eval case, ms. 0/undefined = disabled (no cap). */
  evalMaxCaseMs: number;
  /** Soft $ cap per eval case (checked at turn granularity). 0/undefined = disabled. */
  evalMaxCaseCostUsd: number;
  /** Circuit breaker: abort the rest of the run after this many consecutive
   * per-case `error` results (e.g. provider quota exhausted — every case would
   * otherwise burn its retries and fail the same way). 0 = disabled. */
  evalMaxConsecutiveErrors: number;
  /** User-supplied $/1M-token price table, keyed by exact model ID string
   * (must match `llm.model`). No baked-in defaults — filled in by the user via
   * `cleak config set pricing.<modelId>.inputPerMillion <price>`. */
  pricing: Record<string, { inputPerMillion?: number; outputPerMillion?: number }>;
}

export interface EnvOverrides {
  staticUrl?: string;
  dynamicUrl?: string;
  /** A canonical provider type or a named profile — see RunConfig.provider. */
  provider?: string;
  llm?: Partial<ProviderConfig>;
  consensus?: { n?: number };
  resultsDir?: string;
}
