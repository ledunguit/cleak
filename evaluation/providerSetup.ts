/**
 * Thin wrapper over @cleak/config for the wizard's "advanced: provider" step.
 *
 * Scope boundary (verified against evalHarness.ts): `EvalOptions` has no per-run
 * `baseUrl`/`model`/`apiKey` override — only `provider`. So "config like the TUI"
 * for an EVAL run can only mean (a) picking `provider`, which flows straight into
 * `EvalOptions.provider`, and (b) viewing/editing the PERSISTED
 * `endpoints.<provider>.*` in `~/.config/cleak/config.json` — exactly what
 * `cleak config set` already does. The wizard must say this out loud, not paper
 * over it: editing here changes the saved config, not just this one run.
 */
import { loadConfig, setConfigKey, type Provider } from '@cleak/config';

export interface ProviderSummary {
  baseUrl?: string;
  model?: string;
  apiKeySet: boolean;
}

/** Never returns the raw API key — only whether one is set. */
export function currentProviderSummary(provider: Provider): ProviderSummary {
  const cfg = loadConfig({ provider });
  return {
    baseUrl: cfg.llm.baseUrl || undefined,
    model: cfg.llm.model || undefined,
    apiKeySet: !!cfg.llm.apiKey,
  };
}

export function persistEndpointOverride(provider: Provider, field: 'baseUrl' | 'model' | 'apiKey', value: string): string {
  return setConfigKey(`endpoints.${provider}.${field}`, value);
}
