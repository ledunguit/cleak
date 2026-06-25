/**
 * Heuristic (LLM-free) verdict for a bundle — a thin wrapper over the shared
 * judge so the TUI's no_llm verdicts and un-verdicted-bundle finalization are
 * byte-identical to the control plane's. `judgeHeuristically` reads the source
 * (bundle.candidate.file_path is a host path) and `enrichLeakVerdict` guarantees
 * a root cause + applicable repair diff on every leak verdict.
 */

import type { LeakBundle, VerdictResult } from '@cleak/common/types';
import { judgeHeuristically, enrichLeakVerdict } from '@cleak/common/analysis/heuristic-judge';

export function heuristicVerdict(
  bundle: LeakBundle,
  staticContext: Record<string, any> = {},
): VerdictResult {
  const verdict = judgeHeuristically(bundle, staticContext);
  return enrichLeakVerdict(bundle, staticContext, verdict);
}
