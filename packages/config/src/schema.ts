import { z } from 'zod';

export const PROVIDERS = ['local', 'openai', 'anthropic', 'openai-compat'] as const;

/** Accept JSON booleans and the common string spellings (for `config set x true`). */
const zBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'yes');
/** Accept numbers and numeric strings (for `config set maxTurns 30`). */
const zNum = z.coerce.number();

const endpointSchema = z
  .object({
    baseUrl: z.string(),
    model: z.string(),
    apiKey: z.string(),
    // Which transport this named profile uses. Absent for a profile named exactly
    // 'local'/'openai'/'anthropic'/'openai-compat' (falls back to the name itself,
    // matching pre-multi-profile behavior); required for any other custom name
    // (e.g. a second openai-compat-shaped vendor like "deepseek-direct").
    provider: z.enum(PROVIDERS),
  })
  .partial();

export const CleakConfigSchema = z
  .object({
    // TUI session defaults (not part of RunConfig — consumed by launchTui).
    defaultMode: z.enum(['no_llm', 'llm_assisted']),
    defaultDynamic: z.enum(['off', 'selective', 'aggressive']),
    autoShowReport: zBool,
    // Active profile: a lookup key into `endpoints` below. For every config that
    // predates multi-profile support this is one of the 4 canonical provider-type
    // names, which is also a valid `endpoints` key, so old configs resolve
    // identically. A custom name (e.g. "deepseek-direct") is equally valid as long
    // as `endpoints.<name>.provider` declares its transport — see endpointSchema.
    provider: z.string(),
    // Named endpoint profiles, keyed by an arbitrary name (not just the 4 provider
    // types) so e.g. two different openai-compat-shaped vendors can be configured
    // side by side and switched between via `provider` without overwriting each
    // other. Resolution/validation (does `provider` resolve to a real profile with
    // a known transport?) happens in loader.ts's resolveProvider(), not here —
    // `set`'s per-key validation only ever sees a partial probe object, so a
    // cross-field check here would reject setting `provider` before its
    // `endpoints.<name>` entry exists.
    endpoints: z.record(z.string(), endpointSchema),
    // Analyzer MCP endpoints (the headline reason this file exists).
    staticUrl: z.string(),
    dynamicUrl: z.string(),
    // Default build command for the deterministic dynamic recipe (buildTarget →
    // lsanRun). Empty/absent ⇒ dynamic staging stays off unless a --build flag is
    // passed per run (CLI flag > config file > default).
    buildCommand: z.string(),
    // Host↔analyzer path mapping (Docker analyzers).
    hostRoot: z.string(),
    analyzerRoot: z.string(),
    // Outputs + agent budget.
    resultsDir: z.string(),
    maxTurns: zNum,
    // Provider-agnostic LLM tuning.
    llm: z
      .object({
        temperature: zNum,
        judgeTemperature: zNum,
        timeoutMs: zNum,
        idleTimeoutMs: zNum,
        connectTimeoutMs: zNum,
        retries: zNum,
        maxTokens: zNum,
        jsonMode: zBool,
      })
      .partial(),
    compaction: z.object({ thresholdTokens: zNum, keepRecentTurns: zNum }).partial(),
    workflow: z
      .object({
        staticConcurrency: zNum,
        staticGroupSize: zNum,
        judgeConcurrency: zNum,
        targetedHarness: z
          .object({
            enabled: zBool,
            maxHarnessesPerScan: zNum,
            concurrency: zNum,
            timeoutMs: zNum,
            fuzzBudgetMs: zNum,
            maxClosureFiles: zNum,
            verifyConfirmedLeaks: zBool,
          })
          .partial(),
        allocatorVerification: z
          .object({
            enabled: zBool,
            maxVerifications: zNum,
            concurrency: zNum,
            timeoutMs: zNum,
          })
          .partial(),
        ownershipVerification: z
          .object({
            enabled: zBool,
            maxVerifications: zNum,
            concurrency: zNum,
            timeoutMs: zNum,
          })
          .partial(),
      })
      .partial(),
    consensus: z
      .object({
        n: zNum,
        rule: z.enum(['majority', 'weighted', 'unanimous-to-flag']),
        temperature: zNum,
        concurrency: zNum,
        // Opt-in early-stop sampling (default false — samples all n, unchanged historical
        // behavior). See @cleak/common's isDecisionLocked for the guarantee this relies on.
        earlyStop: zBool,
      })
      .partial(),
    // UI / runtime flags (previously env-only).
    fullscreen: zBool,
    sidebarPosition: z.enum(['left', 'right']),
    // External tool paths (previously env-only).
    baselines: z.object({ clangBin: z.string(), inferBin: z.string() }).partial(),
    // Eval-time path remapping (previously env-only) + per-case budget caps.
    eval: z
      .object({
        staticPathMap: z.string(),
        /** Wall-clock deadline per case, ms. 0 = disabled (no cap). */
        maxCaseMs: zNum,
        /** Soft $ cap per case (checked at turn granularity, not instant). 0 = disabled. */
        maxCaseCostUsd: zNum,
        /** Abort the run after this many consecutive per-case errors. 0 = disabled. */
        maxConsecutiveErrors: zNum,
      })
      .partial(),
    // User-supplied $/1M-token price table, keyed by exact model ID — no
    // baked-in defaults, the user fills this in themselves.
    pricing: z.record(z.string(), z.object({ inputPerMillion: zNum, outputPerMillion: zNum }).partial()),
  })
  .partial();

export type CleakConfig = z.infer<typeof CleakConfigSchema>;
export type EndpointOverride = z.infer<typeof endpointSchema>;

/** The TUI session defaults that aren't otherwise represented in RunConfig. */
export const DEFAULT_CONFIG: CleakConfig = {
  defaultMode: 'llm_assisted',
  defaultDynamic: 'off',
  autoShowReport: false,
  sidebarPosition: 'right',
};
