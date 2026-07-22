/**
 * Contract for the agentic investigation phase. The implementation (M3) runs the
 * native tool-calling loop over the MCP + domain toolset, accumulating evidence
 * and verdicts on the shared CandidateManager. Defined as an interface so the
 * controller stays decoupled and discovery/judging can run without it.
 */

import type { AgentEvent, McpClient } from '@cleak/agent-core';
import type { AgentDecision } from '@cleak/common/types';
import type { ScanEmitter } from './events';
import type { PathResolver } from '../domain/pathResolver';
import type { CandidateManager } from '../domain/candidateState';

/** Identifies which (sub-)agent an event belongs to, for per-agent log separation. */
export interface AgentMeta {
  id: string;
  label: string;
  kind: 'main' | 'static' | 'dynamic';
}

/**
 * Shared deps between ScanDeps (scanController) and InvestigationContext (investigation).
 * Extracted to avoid duplication of the 7 fields common to both interfaces.
 */
export interface OrchestratorCommonDeps {
  pathResolver: PathResolver;
  abortSignal?: AbortSignal;
  onAgentEvent?: (ev: AgentEvent, agent?: AgentMeta) => void;
  onModelActivity?: (dir: 'send' | 'receive') => void;
  requestPermission?: (req: { id: string; name: string; input: unknown }) => Promise<'allow' | 'deny'>;
  getSteering?: () => string[];
  awaitResume?: (reason: string) => Promise<'resume' | 'abort'>;
}

export type InvestigationContext = {
  repoPath: string;
  buildCommand?: string;
  emitter: ScanEmitter;
  staticClient: McpClient;
  dynamicClient?: McpClient;
  /** Project memory-ownership conventions (LLM-discovered by the allocator profiler):
   * e.g. "cJSON_Add*ToObject transfers ownership to the parent", "X returns owned
   * memory freed with Y". Passed to the LLM judge so verdicts respect project semantics
   * no fixed rule could encode. */
  projectOwnershipNotes?: string[];
  /** Dynamic-only discovery (static=false) already built+ran the target and stamped
   * coverage during discovery. When true the investigation skips Stage B (no second
   * build/run) and preserves the coverage already attached to each bundle. */
  dynamicAlreadyRan?: boolean;
} & OrchestratorCommonDeps;

export interface InvestigationOutcome {
  reason: string;
  turns: number;
  agentDecisions?: AgentDecision[];
  /** The agent message history, persisted as transcript.json for reproducibility. */
  transcript?: unknown[];
  /** Human-readable step-by-step markdown log (thinking, tool calls, results). */
  stepsLog?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Accumulated per-bundle static context (evidence the judge scores), keyed by bundleId. */
  staticContext?: Record<string, Record<string, any>>;
}

export interface InvestigationPhase {
  run(candidates: CandidateManager, ctx: InvestigationContext): Promise<InvestigationOutcome>;
}
