export type ProviderName = 'local' | 'openai' | 'anthropic';

/** Connection settings for a model backend (the app maps its config to this). */
export interface ProviderSettings {
  provider: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  /** Total-deadline timeout for the legacy non-streaming path (e.g. control-plane judge). */
  timeoutMs: number;
  /** Max gap between streamed chunks before the request is considered hung. */
  idleTimeoutMs: number;
  /** Time-to-first-byte budget (headers) before giving up on connecting. */
  connectTimeoutMs: number;
  retries: number;
}
