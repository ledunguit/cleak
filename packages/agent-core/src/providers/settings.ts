export type ProviderName = 'local' | 'openai' | 'anthropic';

/** Connection settings for a model backend (the app maps its config to this). */
export interface ProviderSettings {
  provider: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  retries: number;
}
