/**
 * Stage B2 gate: which bundles get a targeted harness. Modeled on `shouldEscalate`
 * (llmJudge.ts) — heuristic-uncertain AND not already resolved by the cheap
 * whole-binary Stage B run AND has static context to build a harness from.
 */

import { InvestigationVerdict, type LeakBundle } from '@cleak/common/types';
import { isBorderline } from './llmJudge';
import type { StaticContextStore } from './staticContext';

export function needsTargetedDynamic(
  bundle: LeakBundle,
  staticStore: StaticContextStore,
  hasBuildCommand: boolean,
  verifyConfirmedLeaks = false,
): boolean {
  if (!hasBuildCommand) return false;
  if (!bundle.verdict) return false;
  if (!staticStore.has(bundle.bundleId)) return false;
  // The cheap global run already confirmed a correlated leak for this bundle — a
  // targeted harness adds nothing.
  if (bundle.dynamicCoverage === 'exercised_leak') return false;
  if (isBorderline(bundle.verdict)) return true;
  // Opt-in widening: double-check a confident CONFIRMED_LEAK too. A clean result
  // here routes to the LLM/consensus judge automatically via `shouldEscalate`'s
  // existing `dynamicRanClean` check (llmJudge.ts) — no other code involved.
  return verifyConfirmedLeaks && bundle.verdict.verdict === InvestigationVerdict.CONFIRMED_LEAK;
}
