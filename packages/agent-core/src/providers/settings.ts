export type ProviderName = 'local' | 'openai' | 'anthropic';

/** Connection settings for a model backend (the app maps its config to this). */
export interface ProviderSettings {
  provider: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  /**
   * Sampling temperature. Omit to use the provider default. Pin it (e.g. 0) for
   * reproducible thesis runs; a per-request `temperature` overrides this.
   */
  temperature?: number;
  /** Total-deadline timeout for the legacy non-streaming path (e.g. control-plane judge). */
  timeoutMs: number;
  /** Max gap between streamed chunks before the request is considered hung. */
  idleTimeoutMs: number;
  /** Time-to-first-byte budget (headers) before giving up on connecting. */
  connectTimeoutMs: number;
  retries: number;
  /** Request the provider's native JSON-object response mode for tool-less (single-shot
   * prose-JSON) calls — the judge/strategist/allocator-profiler prompts already instruct
   * "respond with a JSON object ONLY", so this constrains the provider to actually honor
   * that instead of relying purely on prompt compliance + a regex-fallback parse. Only
   * applied when no tools are attached (see callOpenAiChat) — never interferes with the
   * agentic tool-calling loops. */
  jsonMode?: boolean;
}
