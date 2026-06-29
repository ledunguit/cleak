/**
 * Runtime (zod) schema for the v2 labeled corpus manifest. The eval scorer and the
 * ingest scripts share the TypeScript `LabeledManifest`/`LabeledCase` interfaces, but
 * nothing validated a `corpus_manifest.json` at RUNTIME — a malformed/incomplete
 * manifest reached the scorer and silently skewed metrics. This schema is the (a)
 * gate in `scripts/corpus/validate-corpus.ts` and an optional load-time guard in the
 * eval harness.
 *
 * Pure zod, no Node imports, so @cleak/common stays bundleable.
 */
import { z } from 'zod';

/** A function name must be a non-empty token OR explicitly empty (LAMeD file-level flaws). */
const FunctionName = z.string();

export const LabeledFlawSchema = z
  .object({
    file: z.string().optional(),
    function: FunctionName,
    line: z.number().int().nonnegative().optional(),
    cwe: z.string().optional(),
  })
  .passthrough();

export const CleanSiteSchema = z
  .object({
    file: z.string().optional(),
    function: FunctionName,
    line: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const LabeledCaseSchema = z
  .object({
    id: z.string().min(1),
    repo_path: z.string().min(1),
    build_command: z.string().optional(),
    flaws: z.array(LabeledFlawSchema).optional(),
    clean: z.array(CleanSiteSchema).optional(),
    expected_leak_count: z.number().int().nonnegative().optional(),
    cwe: z.string().optional(),
    flowVariant: z.string().optional(),
    functionalVariant: z.string().optional(),
    allocators: z.array(z.string()).optional(),
    deallocators: z.array(z.string()).optional(),
  })
  .passthrough() // tolerate provenance extras (_lamed, source_origin, file hashes…)
  .refine((c) => (c.flaws?.length ?? 0) > 0 || c.expected_leak_count !== undefined, {
    message: 'case has no flaws[] and no expected_leak_count — unscoreable ground truth',
  });

export const LabeledManifestSchema = z
  .object({
    schema_version: z.string().min(1),
    name: z.string().optional(),
    cases: z.array(LabeledCaseSchema).min(1),
    allocators: z.array(z.string()).optional(),
    deallocators: z.array(z.string()).optional(),
  })
  .passthrough();

export type LabeledFlawZ = z.infer<typeof LabeledFlawSchema>;
export type LabeledCaseZ = z.infer<typeof LabeledCaseSchema>;
export type LabeledManifestZ = z.infer<typeof LabeledManifestSchema>;

/** Parse + validate a manifest object; throws ZodError with a precise path on failure. */
export function parseManifest(raw: unknown): LabeledManifestZ {
  return LabeledManifestSchema.parse(raw);
}

/** Non-throwing variant returning the zod result (for collecting all errors in a report). */
export function safeParseManifest(raw: unknown) {
  return LabeledManifestSchema.safeParse(raw);
}
