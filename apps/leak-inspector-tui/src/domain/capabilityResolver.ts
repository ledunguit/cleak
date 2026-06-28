/**
 * Maps the academic ablation flags (baselineConfig.ts `Capabilities`) onto the
 * orchestrator's concrete run knobs. This is the single bridge between "what the
 * paper calls the axis" and "what switch the engine already has", so the sweep
 * runner and any future `--baseline` CLI path resolve identically.
 *
 * Knob provenance (see docs/ABLATION-PLAN.md + the plan file):
 *  - fusion        → mode (`llm_assisted` ↔ `no_llm`)            scanController.ts:227
 *  - dynamic       → dynamic mode (`selective` ↔ `off`)          dynamicEvidence.ts:252
 *  - planner       → strategy (`auto` ↔ `off`)                   headless.ts:146
 *  - tool_selector → agentic Stage A queryLoop ↔ deterministic   workflowInvestigation.ts:173  (Step 4b)
 *  - static        → static candidate discovery on/off           scanController.ts:166         (Step 4a)
 *
 * `enrich` (deterministic functionSummary+pathConstraints, the STATIC_ENRICH path)
 * is turned ON exactly when the LLM judge needs static evidence but the agentic
 * tool-selector is OFF — i.e. it is the deterministic substitute for Stage A. It
 * stays OFF for the pure-heuristic baselines (B1/B3) so their numbers match the
 * existing no_llm baseline (Juliet TP29 FP7), which `enrich` would otherwise inflate.
 */

import { validateCapabilities, type Capabilities } from './baselineConfig';

export interface ResolvedRunPlan {
  /** AnalysisMode string consumed by runHeadless/runEval. */
  mode: 'no_llm' | 'llm_assisted';
  /** DynamicMode string. `selective` whenever dynamic is enabled (aggressive is not yet differentiated). */
  dynamic: 'off' | 'selective' | 'aggressive';
  /** `--strategy` value — `auto` runs the LLM strategist, `off` bypasses it. */
  strategy: 'auto' | 'off';
  /** Agentic tool selection (LLM-driven Stage A). OFF ⇒ deterministic recipe. */
  toolSelect: boolean;
  /** Static candidate discovery (candidateScan). OFF ⇒ dynamic-only discovery. */
  staticDiscovery: boolean;
  /** Deterministic static enrichment (STATIC_ENRICH equivalent) — the non-agentic
   *  way to feed static evidence to the judge. */
  enrich: boolean;
  /** Consensus samples for the LLM judge (fusion only). */
  consensusN?: number;
  /** Repeat count for variance reporting. */
  runs: number;
}

export interface ResolveOptions {
  consensusN?: number;
  runs?: number;
}

/**
 * Resolve a capability vector into the concrete run plan. Throws on an illegal
 * combination (defence in depth — `loadBaselineConfig` already rejects these, but
 * a programmatically-built `Capabilities` could be invalid).
 */
export function resolveCapabilities(caps: Capabilities, opts: ResolveOptions = {}): ResolvedRunPlan {
  const problems = validateCapabilities(caps);
  if (problems.length) {
    throw new Error(`illegal capability combination: ${problems.join('; ')}`);
  }
  const fusion = caps.fusion;
  return {
    mode: fusion ? 'llm_assisted' : 'no_llm',
    dynamic: caps.dynamic ? 'selective' : 'off',
    strategy: caps.planner ? 'auto' : 'off',
    toolSelect: caps.tool_selector,
    staticDiscovery: caps.static,
    enrich: caps.static && fusion && !caps.tool_selector,
    // Consensus only matters when fusion is on.
    consensusN: fusion ? (opts.consensusN ?? 1) : undefined,
    // Deterministic (no fusion) runs once; otherwise honour the requested repeat count.
    runs: fusion ? Math.max(1, opts.runs ?? 1) : 1,
  };
}
