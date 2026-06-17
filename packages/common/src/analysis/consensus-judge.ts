/**
 * consensus-judge — the thesis's core contribution: a static+dynamic unified
 * judge that combines N INDEPENDENT LLM verdicts (self-consistency) into one
 * verdict, with a heuristic precision-override. It exists to tame the recall↑/FP↑
 * trade-off that LLM-guided leak detection exhibits (LAMeD, EASE 2025): more
 * recall comes with a flood of false positives, and a single LLM call is a noisy
 * arbiter. Sampling the judge N times and requiring agreement — weighted by the
 * static/dynamic evidence — cuts false positives while preserving recall.
 *
 * Layering: this module lives in `@mcpvul/common` so BOTH judge paths (the TUI's
 * native tool-calling loop and the control-plane JSON orchestrator) share ONE
 * consensus implementation, which is what makes the ablation
 * (heuristic | single-LLM | N-consensus) a clean, like-for-like comparison. The
 * per-sample LLM call itself is INJECTED (`sampleJudge`) because issuing it is an
 * app-level concern (provider config, MCP, transport); the combination logic and
 * the heuristic override are the shared, reusable, unit-testable core here.
 */

import { InvestigationVerdict, ToolKind, type LeakBundle, type VerdictResult } from '../types';
import { judgeHeuristically } from './heuristic-judge';
import { LEAK_POSITIVE_VERDICTS, evidenceIndicatesLeak } from './judge-shared';

export type ConsensusRule = 'majority' | 'weighted' | 'unanimous-to-flag';

export interface ConsensusConfig {
  /** Number of independent LLM verdicts to sample (1 reproduces the single-LLM path). */
  n: number;
  /** How the N votes are combined into a flag/no-flag decision. */
  rule: ConsensusRule;
  /** Per-sample sampling temperature (>0 for genuine self-consistency diversity). */
  temperature: number;
  /** Cap on concurrent sample calls (defaults to n). Protects a single LLM gateway. */
  concurrency?: number;
}

/** A compact view of the fused static + dynamic evidence, recorded for provenance. */
export interface EvidenceFusion {
  /** Static signals point to a leak, to clean code, or are inconclusive. */
  static: 'leak' | 'clean' | 'ambiguous';
  /** A runtime tool confirmed a leak here, cleared this site, or never ran it. */
  dynamic: 'confirmed' | 'cleared' | 'none';
}

export interface ConsensusVerdict extends VerdictResult {
  /** The N raw per-sample verdicts (provenance for the thesis's agreement analysis). */
  samples: Array<{ verdict: string; confidence: number }>;
  /** Fraction of samples agreeing with the consensus flag/no-flag decision, in [0,1]. */
  agreement: number;
  /** The static/dynamic evidence summary the decision was conditioned on. */
  evidenceFusion: EvidenceFusion;
  /** True when the heuristic precision-override vetoed a consensus FLAG. */
  overridden?: boolean;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** A verdict string that counts as flagging a leak (positive prediction). */
function isFlag(verdict: string): boolean {
  return LEAK_POSITIVE_VERDICTS.has(verdict);
}

/**
 * Summarize the bundle's evidence into the two axes the consensus weighs. A
 * runtime leak CORRELATED to this candidate is decisive confirmation; a dynamic
 * run that exercised the site without flagging it clears the site. Static "leak"
 * = an unpaired alloc→free or a reachable leak path; "clean" = ownership handed
 * out (the caller's to free).
 */
export function deriveFusion(bundle: LeakBundle): EvidenceFusion {
  // Prefer the EXPLICIT deterministic coverage status; fall back to evidence
  // inference for bundles that predate it (back-compat).
  const cov = bundle.dynamicCoverage;
  const correlatedLeak = bundle.evidence.some((e) => e.correlatedToCandidate === true && evidenceIndicatesLeak(e));
  const anyLeakIndicated = bundle.evidence.some((e) => evidenceIndicatesLeak(e));
  const dynamic: EvidenceFusion['dynamic'] =
    cov === 'exercised_leak'
      ? 'confirmed'
      : cov === 'exercised_clean'
        ? 'cleared'
        : cov === 'not_exercised' || cov === 'dynamic_off'
          ? 'none'
          : correlatedLeak // back-compat (no coverage field set)
            ? 'confirmed'
            : bundle.evidence.length > 0 && !anyLeakIndicated
              ? 'cleared'
              : 'none';

  const se = bundle.staticEvidence;
  let stat: EvidenceFusion['static'] = 'ambiguous';
  if (se) {
    const reachableLeak = (se.feasibleLeakPaths || []).some((lp) => lp.reachable && lp.leakRisk !== 'none');
    const unpaired = (se.allocFreePairs || []).some((p) => p.status === 'unpaired');
    const ownedOut = !!se.ownership?.ownershipCarrier?.kind && se.ownership.ownershipCarrier.kind !== 'none';
    if (reachableLeak || unpaired) stat = 'leak';
    else if (ownedOut) stat = 'clean';
  }
  return { static: stat, dynamic };
}

/** Strong heuristic exculpation: the precision gates (dynamic-cleared / freed-by-callee)
 * returned a confident non-leak verdict that should veto a noisy consensus flag. */
function isStrongExculpation(h: VerdictResult): boolean {
  const exculpatory =
    h.verdict === InvestigationVerdict.LIKELY_FALSE_POSITIVE || h.verdict === InvestigationVerdict.FALSE_POSITIVE;
  return exculpatory && (h.confidence ?? 0) >= 0.75;
}

/** The representative verdict string for an agreeing cluster: the modal verdict,
 * ties broken by summed confidence (then conservatively toward the less severe). */
function pickModalVerdict(cluster: VerdictResult[], flagged: boolean): string {
  if (cluster.length === 0) {
    return flagged ? InvestigationVerdict.LIKELY_LEAK : InvestigationVerdict.UNCERTAIN;
  }
  const byVerdict = new Map<string, { count: number; conf: number }>();
  for (const v of cluster) {
    const cur = byVerdict.get(v.verdict) ?? { count: 0, conf: 0 };
    cur.count += 1;
    cur.conf += clamp01(v.confidence ?? 0.5);
    byVerdict.set(v.verdict, cur);
  }
  // Severity order: prefer the LESS severe on a tie (precision-conservative).
  const severity: Record<string, number> = {
    confirmed_leak: 5,
    likely_leak: 4,
    uncertain: 3,
    likely_false_positive: 2,
    false_positive: 1,
  };
  let best: string = cluster[0].verdict;
  let bestScore = -1;
  let bestConf = -1;
  for (const [verdict, agg] of byVerdict.entries()) {
    if (
      agg.count > bestScore ||
      (agg.count === bestScore && agg.conf > bestConf) ||
      (agg.count === bestScore && agg.conf === bestConf && (severity[verdict] ?? 3) < (severity[best] ?? 3))
    ) {
      best = verdict;
      bestScore = agg.count;
      bestConf = agg.conf;
    }
  }
  return best;
}

/**
 * Combine N independent sample verdicts into one consensus verdict (PURE — no I/O,
 * fully unit-testable with scripted samples). `heuristic` is the deterministic
 * verdict used as the precision-override oracle; `fusion` is the evidence summary.
 */
export function combineVerdicts(
  samples: VerdictResult[],
  heuristic: VerdictResult,
  fusion: EvidenceFusion,
  cfg: ConsensusConfig,
): ConsensusVerdict {
  const valid = samples.filter((v): v is VerdictResult => v != null);
  const n = valid.length;
  const rawSamples = valid.map((v) => ({ verdict: v.verdict, confidence: clamp01(v.confidence ?? 0.5) }));

  // No usable LLM samples → defer entirely to the heuristic (safe, never worse).
  if (n === 0) {
    return { ...heuristic, samples: rawSamples, agreement: 0, evidenceFusion: fusion };
  }

  // A vote's weight. `weighted` rule discounts votes that contradict decisive
  // dynamic evidence — the lever that suppresses false positives a clean run rebuts.
  const weightOf = (v: VerdictResult): number => {
    if (cfg.rule !== 'weighted') return 1;
    const conf = clamp01(v.confidence ?? 0.5);
    const flag = isFlag(v.verdict);
    if (flag && fusion.dynamic === 'cleared') return conf * 0.3; // flagging a cleared site
    if (!flag && fusion.dynamic === 'confirmed') return conf * 0.3; // clearing a confirmed leak
    return conf;
  };

  const flagging = valid.filter((v) => isFlag(v.verdict));
  let flagged: boolean;
  if (cfg.rule === 'unanimous-to-flag') {
    flagged = flagging.length === n; // every sample must agree to flag
  } else if (cfg.rule === 'weighted') {
    const total = valid.reduce((a, v) => a + weightOf(v), 0) || 1;
    const flagW = flagging.reduce((a, v) => a + weightOf(v), 0);
    flagged = flagW / total > 0.5;
  } else {
    flagged = flagging.length * 2 > n; // strict majority
  }

  const cluster = valid.filter((v) => isFlag(v.verdict) === flagged);
  const agreement = cluster.length / n;
  const verdictStr = pickModalVerdict(cluster, flagged);
  const meanConf = cluster.reduce((a, v) => a + clamp01(v.confidence ?? 0.5), 0) / (cluster.length || 1);
  const confidence = clamp01(agreement * meanConf);

  // Carry the representative sample's structured fields (rootCause/repairDiff/
  // explanation were already enriched per-sample by the caller).
  const rep = cluster.find((v) => v.verdict === verdictStr) ?? cluster[0] ?? heuristic;

  // ── Post-consensus heuristic precision override ──
  // A confident heuristic exculpation (a sanitizer cleared this site, or it is
  // freed by a callee) VETOES a consensus flag — a noisy LLM majority cannot flag
  // a site the evidence rebuts. Never override when a runtime leak is correlated
  // to THIS candidate (that is decisive evidence FOR a leak). Overrides only ever
  // REMOVE flags, never add them, so the LLM's recall contribution is preserved.
  if (flagged && isStrongExculpation(heuristic) && fusion.dynamic !== 'confirmed') {
    return {
      ...heuristic,
      tool: ToolKind.HEURISTIC,
      samples: rawSamples,
      agreement,
      evidenceFusion: fusion,
      overridden: true,
      explanation: `[consensus flag vetoed by precision gate] ${heuristic.explanation}`,
    };
  }

  return {
    ...rep,
    verdict: verdictStr as InvestigationVerdict,
    confidence,
    tool: ToolKind.CONSENSUS,
    samples: rawSamples,
    agreement,
    evidenceFusion: fusion,
  };
}

/** Run `n` sample judges with a bounded concurrency pool; failures become null. */
async function sampleAll(
  n: number,
  concurrency: number,
  sampleJudge: (index: number) => Promise<VerdictResult | null>,
): Promise<Array<VerdictResult | null>> {
  const out = new Array<VerdictResult | null>(n).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      try {
        out[i] = await sampleJudge(i);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, n)) }, worker));
  return out;
}

/**
 * Judge one bundle by consensus: sample the injected `sampleJudge` N times, then
 * combine. The returned verdict is fully formed (the representative sample was
 * already enriched with rootCause/repairDiff by the caller). `n: 1` deliberately
 * reproduces the single-LLM judge for a free regression baseline.
 */
export async function judgeByConsensus(
  bundle: LeakBundle,
  staticContext: Record<string, any> | undefined,
  sampleJudge: (index: number) => Promise<VerdictResult | null>,
  cfg: ConsensusConfig,
): Promise<ConsensusVerdict> {
  const n = Math.max(1, Math.floor(cfg.n));
  const results = await sampleAll(n, cfg.concurrency ?? n, sampleJudge);
  const samples = results.filter((v): v is VerdictResult => v != null);
  const heuristic = judgeHeuristically(bundle, staticContext);
  return combineVerdicts(samples, heuristic, deriveFusion(bundle), cfg);
}
