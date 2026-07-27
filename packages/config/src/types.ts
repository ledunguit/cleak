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

export interface EnvOverrides {
  staticUrl?: string;
  dynamicUrl?: string;
  provider?: Provider;
  llm?: Partial<ProviderConfig>;
  consensus?: { n?: number };
  resultsDir?: string;
}
