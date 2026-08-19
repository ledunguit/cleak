import type { ConsensusRule } from '@cleak/common/analysis/consensus-judge';
import type { Provider } from '@cleak/config';

/**
 * A fully-resolved eval run configuration — the shared output of both `wizard.ts`
 * (interactive) and `flags.ts` (non-interactive), consumed by `run.ts`. A superset
 * of `EvalOptions` (from `evalHarness.ts`) plus the couple of fields that only
 * exist at the CLI-orchestration layer (`outDir`, `runs`, `verbose`).
 */
export interface ResolvedPlan {
  corpusDir: string;
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  outDir: string;
  limit?: number;
  stratify?: string;
  randomSeed?: number;
  concurrency?: number;
  resume?: boolean;
  staticUrl?: string;
  dynamicUrl?: string;
  runs: number;
  allowUnvalidated?: boolean;
  consensusN?: number;
  consensusRule?: ConsensusRule;
  strategy?: 'auto' | 'off';
  enrich?: boolean;
  toolSelect?: boolean;
  staticDiscovery?: boolean;
  staticTools?: string[];
  provider?: Provider;
  maxCaseMs?: number;
  maxCaseCostUsd?: number;
  maxConsecutiveErrors?: number;
  /** Judge-verdict disk-cache override. IMPORTANT for `runs > 1` (repeat-for-
   * variance): a cache hit on repeat 2+ would just replay repeat 1's cached
   * verdict, silently collapsing measured LLM run-to-run variance to ~0
   * regardless of the real number. Default (unset) leaves the global config
   * value (true) — pass `--no-judge-cache` for any variance-measuring sweep. */
  judgeCacheEnabled?: boolean;
  /** Stop the run at a case whose LLM judge call hits quota/rate-limit
   * exhaustion instead of silently falling back to the heuristic verdict.
   * Default (unset) leaves the config value (true). */
  pauseOnQuotaExhausted?: boolean;
  verbose: boolean;
}
