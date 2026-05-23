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
export const ToolKindSchema = z.enum(['valgrind', 'asan', 'lsan', 'leakguard', 'heuristic', 'llm']);
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
});

export const VerdictResultSchema = z.object({
  verdict: InvestigationVerdictSchema,
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  evidence: z.array(z.string()),
  tool: ToolKindSchema,
  repair_suggestion: z.string().optional(),
});

export const LeakBundleSchema = z.object({
  bundleId: z.string(),
  candidate: LeakCandidateSchema,
  verdict: VerdictResultSchema.optional(),
  evidence: z.array(LeakEvidenceSchema),
  status: z.enum(['pending', 'investigating', 'confirmed', 'dismissed']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ScanMetadataSchema = z.object({
  scanId: z.string(),
  workspacePath: z.string(),
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
