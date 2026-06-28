/**
 * Declarative ablation baselines for the thesis experiment. Each YAML file under
 * `configs/baselines/` describes ONE configuration of the orchestrator as a vector
 * of five capability flags (static / dynamic / planner / tool_selector / fusion);
 * `capabilityResolver.ts` maps these academic names onto the engine's existing
 * run knobs, and `scripts/run-baselines.ts` sweeps them on a corpus.
 *
 * The flags are the ablation axes from docs/BASELINE_PROPOSED.md. planner and
 * tool_selector are INDEPENDENT axes (so B6a/B6b can isolate each contribution),
 * which is why both can be toggled separately even though the original design
 * only flipped them together at B7.
 *
 * Validated with Zod: an invalid capability combination (e.g. nothing to detect,
 * or an LLM stage without the LLM judge) is a hard parse error — these configs
 * define the experiment, so silent coercion would corrupt the results.
 */

import { z } from 'zod';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** The five ablation axes. */
export const CapabilitiesSchema = z.object({
  /** Static discovery (candidateScan finds allocation sites). OFF ⇒ dynamic-only. */
  static: z.boolean(),
  /** Dynamic stage (build + sanitizer: LSan/ASan/Valgrind). */
  dynamic: z.boolean(),
  /** LLM strategist picks {runDynamic, judge, staticDepth} per project. */
  planner: z.boolean(),
  /** Agentic tool selection (LLM picks tools step-by-step) vs deterministic recipe. */
  tool_selector: z.boolean(),
  /** LLM evidence fusion (LLM/consensus judge on borderline bundles). */
  fusion: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/**
 * Validity rules for a capability vector. Returns a (possibly empty) list of
 * human-readable problems — empty means the combination is legal.
 */
export function validateCapabilities(c: Capabilities): string[] {
  const errs: string[] = [];
  if (!c.static && !c.dynamic) {
    errs.push('at least one of `static`/`dynamic` must be enabled — nothing to detect otherwise');
  }
  if (c.tool_selector && !c.fusion) {
    errs.push('`tool_selector` requires `fusion` — agentic tool selection is LLM-driven');
  }
  if (c.planner && !c.fusion) {
    errs.push('`planner` requires `fusion` — the strategist is an LLM stage');
  }
  return errs;
}

export const BaselineConfigSchema = z
  .object({
    /** Stable short id used as the table row key (e.g. `B1`, `B6a`). */
    id: z.string().min(1),
    /** Human-readable name for the report. */
    name: z.string().min(1),
    description: z.string().optional(),
    capabilities: CapabilitiesSchema,
    /** Consensus samples for the LLM judge (fusion only); default 1 (single LLM). */
    consensusN: z.number().int().positive().optional(),
    /** Repeat count for variance reporting (fusion is non-deterministic); default 1. */
    runs: z.number().int().positive().optional(),
  })
  .superRefine((cfg, ctx) => {
    for (const msg of validateCapabilities(cfg.capabilities)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ['capabilities'] });
    }
    // A non-deterministic (fusion) config benefits from runs>1; a deterministic one
    // must NOT claim variance runs (it would just repeat identical scores).
    if (!cfg.capabilities.fusion && cfg.runs !== undefined && cfg.runs > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`runs` > 1 is meaningless when `fusion` is off (deterministic run)',
        path: ['runs'],
      });
    }
  });

export type BaselineConfig = z.infer<typeof BaselineConfigSchema>;

/** Parse + validate a single baseline YAML file. Throws a labelled error on failure. */
export function loadBaselineConfig(path: string): BaselineConfig {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`baseline config ${path} is not valid YAML: ${(e as Error).message}`);
  }
  const parsed = BaselineConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`baseline config ${path} is invalid: ${detail}`);
  }
  return parsed.data;
}

/**
 * Load every `*.yaml`/`*.yml` baseline in a directory, sorted by id. Throws if any
 * file is invalid or two configs share an id (an id collision would silently drop a
 * row from the ablation table).
 */
export function loadBaselineConfigs(dir: string): BaselineConfig[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  const configs = files.map((f) => loadBaselineConfig(join(dir, f)));
  const seen = new Map<string, string>();
  for (let i = 0; i < configs.length; i++) {
    const prev = seen.get(configs[i].id);
    if (prev) throw new Error(`duplicate baseline id "${configs[i].id}" in ${files[i]} and ${prev}`);
    seen.set(configs[i].id, files[i]);
  }
  return configs.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
