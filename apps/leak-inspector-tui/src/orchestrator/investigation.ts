/**
 * Contract for the agentic investigation phase. The implementation (M3) runs the
 * native tool-calling loop over the MCP + domain toolset, accumulating evidence
 * and verdicts on the shared CandidateManager. Defined as an interface so the
 * controller stays decoupled and discovery/judging can run without it.
 */

import type { AgentEvent, McpClient } from '@mcpvul/agent-core';
import type { AgentDecision } from '@mcpvul/common/types';
import type { ScanEmitter } from './events';
import type { PathResolver } from '../domain/pathResolver';
import type { CandidateManager } from '../domain/candidateState';

export interface InvestigationContext {
  repoPath: string;
  buildCommand?: string;
  emitter: ScanEmitter;
  staticClient: McpClient;
  dynamicClient?: McpClient;
  pathResolver: PathResolver;
  /** Raw agent-loop events (assistant text, tool use/result) for rich UI rendering. */
  onAgentEvent?: (ev: AgentEvent) => void;
  /** Interactive permission resolver (TUI). Absent → 'ask' tools auto-allow (headless). */
  requestPermission?: (req: { id: string; name: string; input: unknown }) => Promise<'allow' | 'deny'>;
  /** Abort signal (ESC) to interrupt the agentic loop. */
  abortSignal?: AbortSignal;
  /** Drained each agent turn — user steering messages injected mid-run. */
  getSteering?: () => string[];
  /** Called when the model fails — resume (user typed continue/guidance) or abort. */
  awaitResume?: (reason: string) => Promise<'resume' | 'abort'>;
}

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
