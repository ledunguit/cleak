import { z } from 'zod';

// ── Enums ──

export const LeakConfidenceSchema = z.enum(['low', 'medium', 'high']);
export const InvestigationVerdictSchema = z.enum([
  'confirmed_leak',
  'likely_leak',
  'uncertain',
  'likely_false_positive',
  'false_positive',
]);
export const ToolKindSchema = z.enum(['valgrind', 'asan', 'lsan', 'scan_build', 'heuristic', 'llm', 'consensus']);
export const AnalysisModeSchema = z.enum(['no_llm', 'llm_assisted']);
export const DynamicModeSchema = z.enum(['off', 'selective', 'aggressive']);
export const DynamicToolPreferenceSchema = z.enum(['auto', 'valgrind', 'lsan', 'asan']);
export const ScanStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);

// ── Objects ──

export const LeakCandidateSchema = z.object({
  id: z.string(),
  function_name: z.string(),
  file_path: z.string(),
  line_number: z.number().int(),
  allocation_site: z.string(),
  allocation_type: z.string(),
  confidence: LeakConfidenceSchema,
  context: z.string(),
});

export const DynamicLeakKindSchema = z.enum([
  'definitely_lost',
  'indirectly_lost',
  'possibly_lost',
  'still_reachable',
  'asan_leak',
  'other',
]);

export const CorrelationMethodSchema = z.enum([
  'file_line_exact',
  'file_line_near',
  'function_match',
  'file_only',
  'none',
]);

export const DynamicCoverageSchema = z.enum([
  'exercised_clean',
  'exercised_leak',
  'not_exercised',
  'dynamic_off',
]);

export const StackFrameRefSchema = z.object({
  function: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  isUserFrame: z.boolean(),
});

export const LeakEvidenceSchema = z.object({
  tool: ToolKindSchema,
  runId: z.string(),
  function_name: z.string(),
  file_path: z.string(),
  line_number: z.number().int(),
  bytes_lost: z.number(),
  blocks_lost: z.number(),
  severity: z.string(),
  stack_trace: z.string(),
  raw_output: z.string(),
  // ── Enriched dynamic evidence (optional / additive) ──
  leakKind: DynamicLeakKindSchema.optional(),
  allocStack: z.array(StackFrameRefSchema).optional(),
  allocSite: z
    .object({ file: z.string(), line: z.number().int(), function: z.string() })
    .optional(),
  signature: z.string().optional(),
  correlatedToCandidate: z.boolean().optional(),
  correlationMethod: CorrelationMethodSchema.optional(),
  correlationDistanceLines: z.number().int().optional(),
});

export const OwnershipSummarySchema = z.object({
  functionName: z.string(),
  filePath: z.string(),
  role: z.enum(['allocator', 'deallocator', 'neither', 'both']),
  ownershipCarrier: z.union([
    z.object({ kind: z.literal('return_value') }),
    z.object({ kind: z.literal('parameter'), name: z.string(), index: z.number().int() }),
    z.object({ kind: z.literal('none') }),
  ]),
  ownershipType: z.string(),
  rationale: z.string(),
});

export const AllocFreePairSchema = z.object({
  variable: z.string(),
  allocCall: z.string(),
  allocLine: z.number().int(),
  allocFile: z.string(),
  freeLine: z.number().int().nullable(),
  freeFunction: z.string().nullable(),
  bindsToNewVariable: z.boolean(),
  status: z.enum(['paired', 'unpaired', 'conditional']),
});

export const FeasibleLeakPathSchema = z.object({
  kind: z.enum(['return', 'goto', 'exit', 'longjmp', 'fallthrough']),
  exitLine: z.number().int(),
  reachable: z.boolean(),
  conditions: z.array(z.string()),
  unreconciledAllocations: z.array(z.string()),
  leakRisk: z.enum(['high', 'medium', 'low', 'none']),
  narrative: z.string(),
  feasibilityChecked: z.enum(['heuristic', 'none']),
});

export const StaticLeakEvidenceSchema = z.object({
  ownership: OwnershipSummarySchema.optional(),
  allocFreePairs: z.array(AllocFreePairSchema),
  feasibleLeakPaths: z.array(FeasibleLeakPathSchema),
  earlyReturnCount: z.number().int(),
  leakyExitPaths: z.number().int(),
});

export const LeakRootCauseSchema = z.object({
  patternType: z.string(),
  description: z.string(),
  allocationFunction: z.string(),
  allocationLine: z.number().int(),
  allocationFile: z.string(),
  missingFreeLine: z.number().int().optional(),
  missingFreeFunction: z.string().optional(),
  rootCauseFunction: z.string(),
  rootCauseLine: z.number().int(),
  rootCauseDescription: z.string(),
});

export const RepairDiffSchema = z.object({
  filePath: z.string(),
  originalLines: z.array(z.string()),
  suggestedLines: z.array(z.string()),
  startLine: z.number().int(),
  description: z.string(),
});

export const VerdictResultSchema = z.object({
  verdict: InvestigationVerdictSchema,
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  evidence: z.array(z.string()),
  tool: ToolKindSchema,
  repair_suggestion: z.string().optional(),
  rootCause: LeakRootCauseSchema.optional(),
  repairDiff: RepairDiffSchema.optional(),
});

export const LeakBundleSchema = z.object({
  bundleId: z.string(),
  candidate: LeakCandidateSchema,
  verdict: VerdictResultSchema.optional(),
  evidence: z.array(LeakEvidenceSchema),
  staticEvidence: StaticLeakEvidenceSchema.optional(),
  dynamicCoverage: DynamicCoverageSchema.optional(),
  status: z.enum(['pending', 'investigating', 'confirmed', 'dismissed']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ScanMetadataSchema = z.object({
  scanId: z.string(),
  workspacePath: z.string(),
  sourceWorkspacePath: z.string().optional(),
  materializedWorkspacePath: z.string().optional(),
  materializedWorkspaceId: z.string().optional(),
  analysisMode: AnalysisModeSchema,
  dynamicMode: DynamicModeSchema,
  fileLimit: z.number().int(),
  buildCommand: z.string().optional(),
  workspaceId: z.string().optional(),
  repoId: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  status: ScanStatusSchema,
});

export const ReportSummarySchema = z.object({
  totalCandidates: z.number().int(),
  confirmedLeaks: z.number().int(),
  likelyLeaks: z.number().int(),
  falsePositives: z.number().int(),
  totalBytesLost: z.number(),
  toolsUsed: z.array(ToolKindSchema),
  durationSec: z.number(),
});

export const ScanReportSchema = z.object({
  scanId: z.string(),
  metadata: ScanMetadataSchema,
  bundles: z.array(LeakBundleSchema),
  summary: ReportSummarySchema,
});

// ── Runtime validation helpers ──
// The schemas above are only worth defining if they actually run at ingestion
// boundaries. These wrappers turn a parsed `unknown` into a typed value, throwing
// a descriptive error instead of letting malformed data flow on as a silent `as` cast.

export type LeakBundleParsed = z.infer<typeof LeakBundleSchema>;

/** Validate one leak bundle; throws with the zod issue list on mismatch. */
export function validateLeakBundle(data: unknown): LeakBundleParsed {
  const r = LeakBundleSchema.safeParse(data);
  if (!r.success) {
    throw new Error(`Invalid LeakBundle: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}

/** Validate a whole scan report (bundles + metadata + summary). */
export function validateScanReport(data: unknown): z.infer<typeof ScanReportSchema> {
  const r = ScanReportSchema.safeParse(data);
  if (!r.success) {
    throw new Error(`Invalid ScanReport: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}
