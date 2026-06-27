/**
 * LLM allocator/deallocator PROFILER. Real projects each wrap memory differently
 * (cJSON factories, apr pools, talloc arenas, GObject refcounting…), so a hardcoded
 * per-project name list never generalizes. Instead we let the LLM READ the project's
 * own headers/source and report its allocation API — the same way the dynamic worker
 * uses the LLM to detect the build command. The discovered names feed the SAME
 * `extraAllocators`/`extraDeallocators` plumbing the static engine already accepts
 * (so the analyzer never changes), and the result is grep-VERIFIED + cacheable so the
 * deterministic guarantees hold.
 *
 * Boundary: the LLM owns the project-specific POLICY (which names are allocators); the
 * deterministic engine owns the MECHANISM (parsing, pairing, Z3). The LLM decides, the
 * engine executes.
 */

import { z } from 'zod';
import { basename, extname, relative, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { walkCFiles, readFileSafe } from './fileWalk';
import type { CallModel } from '@cleak/agent-core';

export const AllocatorProfileSchema = z.object({
  allocators: z.array(z.string()).default([]),
  deallocators: z.array(z.string()).default([]),
  reallocators: z.array(z.string()).default([]),
  ownershipNotes: z.array(z.string()).default([]),
  confidence: z.number().optional(),
  explanation: z.string().optional(),
});
export type AllocatorProfile = z.infer<typeof AllocatorProfileSchema>;

const IDENT = /^[A-Za-z_]\w*$/;
const HEADER_EXTS = new Set(['.h', '.hpp', '.hxx', '.hh']);
// libc primitives the engine already recognizes — never let the LLM "discover" these
// (it would just add noise / dilute the project-specific signal).
const LIBC = new Set([
  'malloc', 'calloc', 'realloc', 'free', 'strdup', 'strndup', 'memdup',
  'xmalloc', 'xcalloc', 'xrealloc', 'xfree', 'xstrdup', 'alloca', 'aligned_alloc',
]);
/** char budget of project text fed to the model (~13k tokens). */
const DEFAULT_BUDGET = 40_000;
/** per-file cap for SOURCE (.c) files so one huge file (cJSON_Utils.c) can't eat the
 * budget and starve the core source where internal/static allocators live. HEADERS are
 * fed in FULL (they declare the public API — truncating them loses e.g. cJSON_Create*). */
const PER_FILE_CAP = 6_000;

function scoreFile(path: string, project: string): number {
  const base = basename(path).toLowerCase();
  const isHeader = HEADER_EXTS.has(extname(path).toLowerCase());
  let score = isHeader ? 100 : 0; // headers first — they carry the public API
  if (base.includes(project)) score += 50; // a file named after the project is the core API
  score -= path.split('/').length; // prefer top-level (public) files over deep internals
  return score;
}

/**
 * Gather the most API-relevant project text within a char budget: headers first (public
 * API), then project-named source, deterministically ordered. Pure + host-side (regex
 * only — tree-sitter is container-only), so it is unit-testable without a real LLM.
 */
export function gatherProjectApiText(
  repoPath: string,
  opts: { budget?: number; fileLimit?: number; perFileCap?: number } = {},
): string {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const project = basename(repoPath).toLowerCase().replace(/[^a-z0-9]/g, '');
  const files = walkCFiles(repoPath, opts.fileLimit ?? 500);
  const ranked = files
    .map((f, i) => ({ f, i, score: scoreFile(f, project) }))
    .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f));
  const parts: string[] = [];
  let used = 0;
  for (const { f } of ranked) {
    if (used >= budget) break;
    const content = readFileSafe(f);
    if (!content) continue;
    // Headers fed in full (the API declarations); .c capped so one giant file can't eat
    // the budget. (The earlier uniform cap truncated cJSON.h before its Create* decls.)
    const isHeader = HEADER_EXTS.has(extname(f).toLowerCase());
    const room = isHeader ? budget - used : Math.min(budget - used, opts.perFileCap ?? PER_FILE_CAP);
    const body = content.length > room ? content.slice(0, room) : content;
    const chunk = `// ===== ${relative(repoPath, f)} =====\n${body}`;
    parts.push(chunk);
    used += chunk.length;
  }
  return parts.join('\n\n');
}

export const allocatorProfileSystemPrompt = [
  `You are a C/C++ memory-management API analyst. Given header/source excerpts from ONE project, identify that project's CUSTOM allocation and deallocation functions — the wrappers/replacements for malloc/free: factory constructors and duplicators (\`*_new\`, \`*_create*\`, \`*_alloc*\`, \`*_dup\`, \`*_clone\`, \`*_copy\` that return owned memory) and their matching releases (\`*_free\`, \`*_delete\`, \`*_destroy\`, \`*_release\`, \`*_unref\`, \`*_close\`, pool/arena destructors) — plus any ownership conventions a leak checker must know.`,
  `Respond with a JSON object ONLY (no prose), in this exact shape:`,
  `{"allocators":["..."],"deallocators":["..."],"reallocators":["..."],"ownershipNotes":["..."],"confidence":0.0-1.0,"explanation":"..."}`,
  `Rules:`,
  `- Be EXHAUSTIVE on allocators: list EVERY function that returns newly-owned memory — ALL constructors/factories (\`*_New*\`, \`*_Create*\`), duplicators (\`*_Duplicate\`, \`*_dup\`, \`*_clone\`, \`*_copy\`), and parsers/printers/serializers that return an owned buffer (\`*_Parse*\`, \`*_Print*\`). Do not stop at a few examples — include the whole family even if it is long.`,
  `- Use EXACT function names as they appear in the code.`,
  `- Include INTERNAL/static helpers too (e.g. a static \`cJSON_malloc\`/\`*_New_Item\` wrapper, a private \`*_strdup\`), not only the public API — leaks often flow through them.`,
  `- Include MACRO allocators/deallocators: a \`#define MY_ALLOC(n) malloc(n)\` (or \`#define FREE_OBJ(p) ...\`) is an allocator/deallocator named \`MY_ALLOC\`/\`FREE_OBJ\` — list the macro name.`,
  `- Do NOT include plain libc malloc/calloc/realloc/free/strdup — the engine already knows those. Only the project's CUSTOM names.`,
  `- allocators/reallocators RETURN newly-owned heap memory the caller is responsible for; deallocators FREE or consume it.`,
  `- ownershipNotes: short, project-specific rules (transfer vs borrow, refcounting, pool/arena "free the pool, not each object", "X skips items flagged Y", a constructor that steals its argument). Empty array if none.`,
  `- Precision over recall: if unsure a name is an allocator/deallocator, OMIT it.`,
].join('\n');

/** Parse a model response into a profile (lenient JSON-in-prose + Zod), mirroring parseVerdict. */
export function parseAllocatorProfile(
  text: string,
): { ok: true; value: AllocatorProfile } | { ok: false; reason: string } {
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
  const parsed = AllocatorProfileSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `schema mismatch: ${parsed.error.issues[0]?.message ?? 'invalid object'}` };
  }
  return { ok: true, value: parsed.data };
}

/** Keep only safe identifiers that are NOT libc and that ACTUALLY appear in the source
 * we showed the model (anti-hallucination), de-duplicated and order-stable. */
export function verifyNames(names: string[] | undefined, sourceText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names ?? []) {
    const name = (n || '').trim();
    if (!IDENT.test(name) || LIBC.has(name) || seen.has(name)) continue;
    if (!new RegExp(`\\b${name}\\b`).test(sourceText)) continue; // must exist in the shown source
    seen.add(name);
    out.push(name);
  }
  return out;
}

export interface ProfileOptions {
  budget?: number;
  fileLimit?: number;
  temperature?: number;
  signal?: AbortSignal;
  onNotice?: (reason: string) => void;
}

/**
 * Discover a project's allocator profile via ONE bounded, temperature-0 LLM call over
 * its API text, then grep-verify every name against that text. Returns null on a call
 * or parse failure (caller falls back to no extra allocators). Deterministic given the
 * same repo (gather is deterministic + temp 0) ⇒ cacheable.
 */
export async function profileAllocators(
  repoPath: string,
  callModel: CallModel,
  opts: ProfileOptions = {},
): Promise<AllocatorProfile | null> {
  const apiText = gatherProjectApiText(repoPath, opts);
  if (!apiText.trim()) {
    opts.onNotice?.(`allocator-profile: no C/C++ headers/source found under ${repoPath}`);
    return null;
  }
  const user = [
    `Project: ${basename(repoPath)}`,
    `Identify this project's custom allocator/deallocator API from the excerpts below. Return JSON only.`,
    ``,
    '```c',
    apiText,
    '```',
  ].join('\n');

  let resp;
  try {
    resp = await callModel({
      systemPrompt: allocatorProfileSystemPrompt,
      messages: [{ role: 'user', content: user }],
      tools: [],
      signal: opts.signal,
      temperature: opts.temperature ?? 0,
    });
  } catch (err: any) {
    opts.onNotice?.(`allocator-profile: model call failed (${err?.message ?? err})`);
    return null;
  }
  const parsed = parseAllocatorProfile(resp.text ?? '');
  if (!parsed.ok) {
    opts.onNotice?.(`allocator-profile: ${parsed.reason}`);
    return null;
  }
  // Grep-verify names against the exact text the model saw.
  return {
    allocators: verifyNames(parsed.value.allocators, apiText),
    deallocators: verifyNames(parsed.value.deallocators, apiText),
    reallocators: verifyNames(parsed.value.reallocators, apiText),
    ownershipNotes: (parsed.value.ownershipNotes ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12),
    confidence: parsed.value.confidence,
    explanation: parsed.value.explanation,
  };
}

/** Path of the per-repo cached profile. */
export function profileCachePath(repoPath: string): string {
  return join(repoPath, '.cleak', 'allocator-profile.json');
}

/**
 * Return a cached profile for this repo if present, else discover one via the LLM and
 * cache it. Caching keys on the repo path, so a re-scan of the same checkout is
 * deterministic and costs no LLM call — this is what keeps "more LLM" reproducible.
 */
export async function loadOrProfileAllocators(
  repoPath: string,
  callModel: CallModel,
  opts: ProfileOptions = {},
): Promise<AllocatorProfile | null> {
  const cacheFile = profileCachePath(repoPath);
  if (existsSync(cacheFile)) {
    try {
      const parsed = AllocatorProfileSchema.safeParse(JSON.parse(readFileSync(cacheFile, 'utf-8')));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to re-profile on a corrupt cache */
    }
  }
  const profile = await profileAllocators(repoPath, callModel, opts);
  if (profile) {
    try {
      mkdirSync(join(repoPath, '.cleak'), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(profile, null, 2));
    } catch {
      /* caching is best-effort */
    }
  }
  return profile;
}
