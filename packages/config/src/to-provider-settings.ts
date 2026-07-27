/**
 * Bridge from the app's {@link RunConfig} to the agent-core {@link ProviderSettings}
 * shape. `openai-compat` is an app-level label for an arbitrary OpenAI-compatible
 * endpoint; agent-core only knows local|openai|anthropic, so it routes through the
 * `openai` chat-completions path (same transport + tool-calling), driven by the
 * custom baseUrl.
 */

import type { ProviderSettings } from '@cleak/agent-core';
import type { RunConfig } from './types.js';

export function toProviderSettings(cfg: RunConfig): ProviderSettings {
  return {
    provider: cfg.llm.provider === 'openai-compat' ? 'openai' : cfg.llm.provider,
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    maxTokens: cfg.llm.maxTokens,
    temperature: cfg.llm.temperature,
    timeoutMs: cfg.llm.timeoutMs,
    idleTimeoutMs: cfg.llm.idleTimeoutMs,
    connectTimeoutMs: cfg.llm.connectTimeoutMs,
    retries: cfg.llm.retries,
  };
}
