/**
 * BOUNDED judge calibrator. The heuristic-judge verdict thresholds are tuned to fit the
 * benchmark; the thesis's honest answer to the "overfit to Juliet" critique is: (a) the
 * weights are EXPLICIT (JUDGE_VERDICT_THRESHOLDS), (b) the EVAL always uses those frozen
 * defaults (this tuner is never engaged there), and (c) a PRODUCTION scan may shift them
 * a little per project — within hard bounds, never free-form — to match the project's
 * ownership style. The LLM proposes; the clamp validates.
 */

import { z } from 'zod';
import { JUDGE_VERDICT_THRESHOLDS, type VerdictThresholds } from '@cleak/common/analysis/heuristic-judge';
import type { CallModel } from '@cleak/agent-core';

// Hard bounds — the LLM can only nudge within these; it can NEVER make the judge
// reckless (confirmed too low) or useless (thresholds inverted).
const BOUNDS = { confirmedMin: 0.55, confirmedMax: 0.85, likelyMin: 0.25, likelyMax: 0.6 };

const TuningSchema = z.object({
  confirmed: z.number(),
  likely: z.number(),
  rationale: z.string().optional(),
});

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Clamp a proposed tuning into the safe envelope (and keep confirmed > likely). */
export function clampThresholds(t: { confirmed: number; likely: number }): VerdictThresholds {
  const confirmed = clamp(t.confirmed, BOUNDS.confirmedMin, BOUNDS.confirmedMax);
  const likely = clamp(t.likely, BOUNDS.likelyMin, Math.min(BOUNDS.likelyMax, confirmed - 0.05));
  return { confirmed, likely };
}

export function parseTuning(text: string): { confirmed: number; likely: number } | null {
  const raw = text?.trim() ?? '';
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      json = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const p = TuningSchema.safeParse(json);
  return p.success ? { confirmed: p.data.confirmed, likely: p.data.likely } : null;
}

export const judgeTunerSystemPrompt = [
  `You calibrate a C/C++ leak judge's verdict thresholds for ONE project. The judge scores each candidate in [0,1]; score ≥ confirmed → confirmed_leak, ≥ likely → likely_leak, else uncertain.`,
  `Defaults: confirmed=${JUDGE_VERDICT_THRESHOLDS.confirmed}, likely=${JUDGE_VERDICT_THRESHOLDS.likely}.`,
  `Nudge them to fit the project's memory style, staying near the defaults. Respond with JSON ONLY: {"confirmed": 0.55-0.85, "likely": 0.25-0.6, "rationale": "..."}.`,
  `Heuristics: heavy smart-pointer/RAII or refcounting (false positives likely) → RAISE confirmed slightly; a project with many obvious manual malloc/free and missing frees → LOWER thresholds slightly to catch more. Keep confirmed > likely. Small moves only.`,
].join('\n');

export interface TuneOptions {
  profileSummary?: string;
  temperature?: number;
  signal?: AbortSignal;
  onNotice?: (reason: string) => void;
}

/**
 * Produce per-project verdict thresholds (LLM, clamped to BOUNDS). Returns the frozen
 * defaults on any failure. PRODUCTION ONLY — never call this in the eval path.
 */
export async function tuneThresholds(callModel: CallModel, opts: TuneOptions = {}): Promise<VerdictThresholds> {
  const user = [
    opts.profileSummary ? `Memory-API profile: ${opts.profileSummary}` : 'No profile available.',
    `Return the calibrated thresholds as JSON.`,
  ].join('\n');
  let resp;
  try {
    resp = await callModel({
      systemPrompt: judgeTunerSystemPrompt,
      messages: [{ role: 'user', content: user }],
      tools: [],
      signal: opts.signal,
      temperature: opts.temperature ?? 0,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onNotice?.(`judge-tuner: model call failed (${msg}); using frozen defaults`);
    return JUDGE_VERDICT_THRESHOLDS;
  }
  const parsed = parseTuning(resp.text ?? '');
  if (!parsed) {
    opts.onNotice?.('judge-tuner: unparseable response; using frozen defaults');
    return JUDGE_VERDICT_THRESHOLDS;
  }
  return clampThresholds(parsed);
}
