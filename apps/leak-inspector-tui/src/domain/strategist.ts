/**
 * Adaptive STRATEGIST — the "intelligent harness". A fixed 4-stage pipeline runs the
 * same way on a 10-file utility and a 500k-LoC monolith. Instead, an LLM planner reads
 * the project's memory-API profile + cheap repo metadata and decides a STRATEGY — which
 * deterministic capabilities to run and how deep — without inventing any new analysis.
 *
 * Boundary (same as the profiler): the LLM owns the POLICY (what plan fits THIS project);
 * the engine executes the chosen plan UNCHANGED. The planner only SELECTS among existing
 * deterministic capabilities, so every finding still traces to a deterministic tool.
 *
 * v0 ships ONE bounded decision object: {runDynamic, judge, staticDepth}. It is OPT-IN
 * (`--strategy auto`) and SKIPPED in the benchmark (which passes an explicit dynamic mode
 * + judge config), so eval determinism + the Juliet baseline are untouched.
 */

import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { walkCFiles, readFileSafe } from './fileWalk';
import type { CallModel } from '@cleak/agent-core';

export const StrategyPlanSchema = z.object({
  runDynamic: z.boolean(),
  judge: z.enum(['single', 'consensus']),
  staticDepth: z.enum(['shallow', 'full']),
  rationale: z.string().optional(),
});
export type StrategyPlan = z.infer<typeof StrategyPlanSchema>;

const BUILD_FILES = ['CMakeLists.txt', 'Makefile', 'makefile', 'meson.build', 'configure', 'configure.ac', 'BUILD.bazel', 'Cargo.toml', 'build.sh'];
const CPP_EXTS = new Set(['.cc', '.cpp', '.cxx', '.hpp', '.hxx', '.hh']);

export interface RepoMetadata {
  fileCount: number;
  cppRatio: number;
  buildSystem: string[];
  smartPtrDensity: number; // rough: smart-ptr/refcount hits per file (sampled)
}

/** Cheap, deterministic host-side metadata (regex only — no tree-sitter). */
export function gatherRepoMetadata(repoPath: string, opts: { fileLimit?: number } = {}): RepoMetadata {
  const files = walkCFiles(repoPath, opts.fileLimit ?? 2000);
  const cpp = files.filter((f) => CPP_EXTS.has(extname(f).toLowerCase())).length;
  const buildSystem = BUILD_FILES.filter((b) => existsSync(join(repoPath, b)));
  // Sample up to 30 files for smart-pointer / refcount idioms.
  const sample = files.slice(0, 30);
  const re = /\b(make_unique|make_shared|unique_ptr|shared_ptr|weak_ptr|_ref\s*\(|_unref\s*\(|Py_INCREF|g_object_ref)\b/;
  let hits = 0;
  for (const f of sample) {
    const c = readFileSafe(f);
    if (c && re.test(c)) hits++;
  }
  return {
    fileCount: files.length,
    cppRatio: files.length ? cpp / files.length : 0,
    buildSystem,
    smartPtrDensity: sample.length ? hits / sample.length : 0,
  };
}

/** Deterministic fallback plan when the LLM is unavailable / fails. Conservative: run
 * everything unless the repo plainly can't build. */
export function fallbackPlan(meta: RepoMetadata): StrategyPlan {
  return {
    runDynamic: meta.buildSystem.length > 0,
    judge: meta.smartPtrDensity > 0.2 || meta.cppRatio > 0.5 ? 'consensus' : 'single',
    staticDepth: meta.fileCount > 12 ? 'full' : 'shallow',
    rationale: 'deterministic fallback (LLM unavailable)',
  };
}

export const strategistSystemPrompt = [
  `You are the STRATEGIST for a C/C++ memory-leak analyzer. Given a project's metadata + memory-API profile, choose an analysis plan by SELECTING among the engine's existing deterministic capabilities — you do not invent analysis. Respond with a JSON object ONLY:`,
  `{"runDynamic": true|false, "judge": "single"|"consensus", "staticDepth": "shallow"|"full", "rationale": "..."}`,
  `Guidance:`,
  `- runDynamic: run sanitizer (LeakSanitizer) dynamic analysis ONLY if the project is plausibly buildable (a build system is present) AND dynamic coverage would help. If there is NO build system, set false — building is impossible, so skip the expensive dynamic stage (no recall lost).`,
  `- judge: "consensus" (slower, more robust) for projects whose ownership is subtle — heavy smart-pointer / refcounting / C++; else "single".`,
  `- staticDepth: "shallow" (function summaries only) for tiny or trivial projects; "full" (path constraints + ownership + interprocedural) for larger or control-flow-heavy ones.`,
  `Be decisive; prefer cheaper plans when they lose no recall.`,
].join('\n');

/** Parse a model response into a plan (lenient JSON + Zod), mirroring parseVerdict/parseAllocatorProfile. */
export function parseStrategyPlan(text: string): { ok: true; value: StrategyPlan } | { ok: false; reason: string } {
  const raw = text?.trim() ?? '';
  if (!raw) return { ok: false, reason: 'empty model response' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, reason: 'no JSON object in response' };
    try {
      json = JSON.parse(m[0]);
    } catch {
      return { ok: false, reason: 'malformed JSON in response' };
    }
  }
  const parsed = StrategyPlanSchema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: `schema mismatch: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
}

export interface StrategyOptions {
  profileSummary?: string;
  fileLimit?: number;
  temperature?: number;
  signal?: AbortSignal;
  onNotice?: (reason: string) => void;
}

/**
 * Decide the analysis strategy for a repo via ONE bounded LLM call over its metadata +
 * profile summary. Falls back to a deterministic rule-based plan on any failure (so the
 * harness never blocks). Deterministic given the same repo (metadata + temp 0).
 */
export async function decideStrategy(
  repoPath: string,
  callModel: CallModel,
  opts: StrategyOptions = {},
): Promise<StrategyPlan> {
  const meta = gatherRepoMetadata(repoPath, opts);
  const user = [
    `Project metadata:`,
    `- files: ${meta.fileCount}, C++ ratio: ${meta.cppRatio.toFixed(2)}, smart-ptr/refcount density: ${meta.smartPtrDensity.toFixed(2)}`,
    `- build system: ${meta.buildSystem.length ? meta.buildSystem.join(', ') : 'NONE detected'}`,
    opts.profileSummary ? `Memory-API profile: ${opts.profileSummary}` : '',
    ``,
    `Choose the analysis plan. Return JSON only.`,
  ].join('\n');

  let resp;
  try {
    resp = await callModel({
      systemPrompt: strategistSystemPrompt,
      messages: [{ role: 'user', content: user }],
      tools: [],
      signal: opts.signal,
      temperature: opts.temperature ?? 0,
    });
  } catch (err: any) {
    opts.onNotice?.(`strategist: model call failed (${err?.message ?? err}); using fallback`);
    return fallbackPlan(meta);
  }
  const parsed = parseStrategyPlan(resp.text ?? '');
  if (!parsed.ok) {
    opts.onNotice?.(`strategist: ${parsed.reason}; using fallback`);
    return fallbackPlan(meta);
  }
  return parsed.value;
}
