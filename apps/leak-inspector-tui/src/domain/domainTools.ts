/**
 * Domain tools exposed to the investigation agent (beyond the raw MCP analysis
 * tools). They let the model see the candidate state, read source, register a
 * missed candidate, and — crucially — record a structured verdict in the shared
 * @cleak/common shape. record_verdict runs every verdict through the shared
 * enrichment so it always carries a root cause + an applicable repair diff.
 */

import { resolve, isAbsolute } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { z } from 'zod';
import { buildTool, type Tool } from '@cleak/agent-core';
import {
  InvestigationVerdict,
  ToolKind,
  type VerdictResult,
  type LeakCandidate,
  type LeakEvidence,
} from '@cleak/common/types';
import { enrichLeakVerdict } from '@cleak/common/analysis/heuristic-judge';
import { deriveDynamicFields, correlateEvidence } from '@cleak/common/analysis/dynamic-evidence';
import { CandidateManager, normalizeCandidate } from './candidateState';
import type { PathResolver } from './pathResolver';

const MAX_FILE_CHARS = 16_000;

export interface DomainToolDeps {
  candidates: CandidateManager;
  repoPath: string;
  pathResolver: PathResolver;
  /** Called when the agent records a verdict (so the phase can track decisions). */
  onVerdict?: (bundleId: string, verdict: VerdictResult, turnArgs: Record<string, unknown>) => void;
}

export const FINALIZE_TOOL = 'finalize_report';

export function buildDomainTools(deps: DomainToolDeps): Tool[] {
  const listCandidates = buildTool({
    name: 'list_candidates',
    description:
      'List the open leak candidates discovered in this repository (id, function, file, line, allocation type, whether a verdict is recorded).',
    inputSchema: z.object({ limit: z.number().int().positive().optional() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async (input: { limit?: number }) => {
      const all = deps.candidates.getAllBundles();
      const limited = input.limit ? all.slice(0, input.limit) : all;
      return {
        total: all.length,
        candidates: limited.map((b) => ({
          bundleId: b.bundleId,
          function: b.candidate.function_name,
          file: b.candidate.file_path,
          line: b.candidate.line_number,
          allocation_type: b.candidate.allocation_type,
          has_verdict: !!b.verdict,
        })),
      };
    },
  });

  const readFile = buildTool({
    name: 'read_file',
    description:
      'Read a source file from the repository (path relative to the repo root, or an absolute path inside it). Returns up to 16000 characters.',
    inputSchema: z.object({ path: z.string() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    renderTitle: (input) => `read_file ${input?.path ?? ''}`,
    call: async (input: { path: string }) => {
      const target = isAbsolute(input.path) ? resolve(input.path) : resolve(deps.repoPath, input.path);
      if (!target.startsWith(resolve(deps.repoPath))) {
        return { error: 'Path is outside the repository root.' };
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        return { error: `File not found: ${input.path}` };
      }
      const content = readFileSync(target, 'utf-8');
      return {
        path: input.path,
        truncated: content.length > MAX_FILE_CHARS,
        content: content.slice(0, MAX_FILE_CHARS),
      };
    },
  });

  const recordCandidate = buildTool({
    name: 'record_candidate',
    description:
      'Register an allocation site that lexical discovery missed (e.g. a custom allocator). Use sparingly, only when you find a real allocation not already listed.',
    inputSchema: z.object({
      functionName: z.string(),
      filePath: z.string(),
      lineNumber: z.number().int().nonnegative(),
      allocationType: z.string().optional(),
      allocationSite: z.string().optional(),
      context: z.string().optional(),
    }),
    call: async (input: any) => {
      const candidate: LeakCandidate = normalizeCandidate(
        { ...input, confidence: 'medium' },
        (p) => deps.pathResolver.toHostPath(p),
      );
      const bundle = deps.candidates.ingest(candidate);
      return { bundleId: bundle.bundleId, registered: true };
    },
  });

  const recordVerdict = buildTool({
    name: 'record_verdict',
    description:
      'Record your verdict for one candidate. Provide the verdict, a confidence in [0,1], and a precise explanation. The system attaches a source-anchored repair diff automatically.',
    inputSchema: z.object({
      bundleId: z.string(),
      verdict: z.enum([
        'confirmed_leak',
        'likely_leak',
        'uncertain',
        'likely_false_positive',
        'false_positive',
      ]),
      confidence: z.number().min(0).max(1),
      explanation: z.string(),
      evidence: z.array(z.string()).optional(),
    }),
    renderTitle: (input) => `record_verdict ${input?.bundleId ?? ''} → ${input?.verdict ?? ''}`,
    call: async (input: any) => {
      const bundle = deps.candidates.getBundle(input.bundleId);
      if (!bundle) return { error: `Unknown bundleId: ${input.bundleId}` };
      const base: VerdictResult = {
        verdict: input.verdict as InvestigationVerdict,
        confidence: input.confidence,
        explanation: input.explanation,
        evidence: Array.isArray(input.evidence) ? input.evidence : [],
        tool: ToolKind.LLM,
      };
      const enriched = enrichLeakVerdict(bundle, {}, base);
      bundle.verdict = enriched;
      bundle.updatedAt = new Date().toISOString();
      deps.onVerdict?.(input.bundleId, enriched, input);
      return {
        bundleId: input.bundleId,
        recorded: true,
        verdict: enriched.verdict,
        confidence: enriched.confidence,
        has_repair_diff: !!enriched.repairDiff,
      };
    },
  });

  const recordEvidence = buildTool({
    name: 'record_evidence',
    description:
      'Attach a dynamic-analysis or scan-build finding to a candidate as evidence (after running a sanitizer / valgrind / clang-sa tool). Strengthens the verdict for that bundle.',
    inputSchema: z.object({
      bundleId: z.string(),
      tool: z.enum(['valgrind', 'asan', 'lsan', 'leakguard']),
      bytesLost: z.number().nonnegative().optional(),
      blocksLost: z.number().nonnegative().optional(),
      severity: z.string().optional(),
      leakKind: z.string().optional(),
      stackTrace: z.string().optional(),
      rawOutput: z.string().optional(),
    }),
    renderTitle: (input) => `record_evidence ${input?.bundleId ?? ''} (${input?.tool ?? ''})`,
    call: async (input: any) => {
      const bundle = deps.candidates.getBundle(input.bundleId);
      if (!bundle) return { error: `Unknown bundleId: ${input.bundleId}` };
      const base: LeakEvidence = {
        tool: TOOL_KIND_BY_NAME[input.tool] ?? ToolKind.HEURISTIC,
        runId: '',
        function_name: bundle.candidate.function_name,
        file_path: bundle.candidate.file_path,
        line_number: bundle.candidate.line_number,
        bytes_lost: Number(input.bytesLost ?? 0),
        blocks_lost: Number(input.blocksLost ?? 0),
        severity: input.severity ?? '',
        stack_trace: input.stackTrace ?? '',
        raw_output: input.rawOutput ?? '',
      };
      // Derive structured fields (leakKind / allocStack / allocSite) from the
      // stack the LLM passed, then record HOW it lines up with the candidate the
      // LLM chose to attach it to.
      const enriched = deriveDynamicFields(base, { rawLeakKind: input.leakKind });
      const corr = correlateEvidence(enriched, bundle.candidate);
      const evidence: LeakEvidence = {
        ...enriched,
        correlatedToCandidate: corr.correlatedToCandidate,
        correlationMethod: corr.correlationMethod,
        correlationDistanceLines: corr.correlationDistanceLines,
      };
      deps.candidates.attachEvidence(input.bundleId, evidence);
      return {
        bundleId: input.bundleId,
        attached: true,
        evidence_count: bundle.evidence.length,
        leak_kind: evidence.leakKind,
        correlation: evidence.correlationMethod,
      };
    },
  });

  const finalize = buildTool({
    name: FINALIZE_TOOL,
    description:
      'Finish the investigation. Call this once every candidate has a recorded verdict. The system then judges any remaining candidates heuristically and renders the report.',
    inputSchema: z.object({ summary: z.string().optional() }),
    call: async (input: { summary?: string }) => {
      const pending = deps.candidates.getAllBundles().filter((b) => !b.verdict).length;
      return { finalized: true, pending_without_verdict: pending, summary: input.summary ?? '' };
    },
  });

  return [listCandidates, readFile, recordCandidate, recordEvidence, recordVerdict, finalize];
}

const TOOL_KIND_BY_NAME: Record<string, ToolKind> = {
  valgrind: ToolKind.VALGRIND,
  asan: ToolKind.ASAN,
  lsan: ToolKind.LSAN,
  leakguard: ToolKind.LEAKGUARD,
};
