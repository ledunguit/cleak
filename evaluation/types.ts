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
  verbose: boolean;
}
