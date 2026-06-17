/**
 * Zod schemas for the LLM JSON outputs the control-plane parses (orchestrator
 * decision, investigation plan, judge verdict). Centralizing the shape + enum
 * constraints here replaces the hand-rolled `typeof`/`Array.isArray` ladders in
 * the services, makes a malformed response a single logged `safeParse` failure
 * (instead of a silent field-by-field fallback), and keeps the verdict taxonomy
 * a single source of truth shared with the heuristic/TUI judge.
 *
 * Schemas validate SHAPE only; context-dependent enrichment (filtering bundle IDs
 * to those that exist, filling defaults from the candidate) stays in the services.
 */

import { z } from 'zod';
import { LEAK_VERDICT_STRINGS } from '@mcpvul/common/analysis/judge-shared';

/** The orchestrator's next-action kinds (kept in sync with the planner prompt). */
export const ACTION_KINDS = [
  'run_static_tool',
  'run_leakguard',
  'run_dynamic',
  'judge_bundle',
  'request_more_evidence',
  'deep_investigate',
  'change_strategy',
  'finish',
] as const;

export const DecisionSchema = z.object({
  actionKind: z.enum(ACTION_KINDS),
  toolName: z.string().optional(),
  targetBundleIds: z.array(z.string()).optional(),
  rationale: z.string().optional(),
  reasoning: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type DecisionParsed = z.infer<typeof DecisionSchema>;

export const PlanSchema = z.object({
  focusBundleIds: z.array(z.string()).optional(),
  staticToolSequence: z.array(z.string()).optional(),
  runLeakguard: z.boolean().optional(),
  runDynamic: z.boolean().optional(),
  dynamicToolPreference: z.string().optional(),
  bundleLimit: z.number().optional(),
  rationale: z.string().optional(),
  notes: z.array(z.coerce.string()).optional(),
});
export type PlanParsed = z.infer<typeof PlanSchema>;

export const VerdictSchema = z.object({
  // The one hard requirement: a verdict from the shared taxonomy. Everything else
  // is optional and enriched downstream (rootCause/repairDiff get the full pass in
  // parseRootCause/parseRepairDiff, which also fill bundle-derived defaults).
  verdict: z.enum([...LEAK_VERDICT_STRINGS]),
  confidence: z.number().optional(),
  explanation: z.string().optional(),
  evidence: z.array(z.unknown()).optional(),
  repair_suggestion: z.string().optional(),
  tool: z.string().optional(),
  rootCause: z.unknown().optional(),
  repairDiff: z.unknown().optional(),
});
export type VerdictParsed = z.infer<typeof VerdictSchema>;

/**
 * Extract the first JSON object from an LLM response and validate it against a
 * schema. Returns the parsed value, or null with the failure reason (so the caller
 * can log WHY a response was rejected instead of silently falling back).
 */
export function parseJsonWith<T>(raw: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; reason: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, reason: 'no JSON object found in response' };
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch (err: any) {
    return { ok: false, reason: `JSON.parse failed: ${err?.message ?? err}` };
  }
  const result = schema.safeParse(obj);
  if (!result.success) {
    return { ok: false, reason: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, value: result.data };
}
