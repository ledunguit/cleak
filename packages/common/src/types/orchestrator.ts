import type { AgentActionKind } from './enums';

// ── Agentic orchestrator state ──

export interface AgentDecision {
  turn: number;
  actionKind: AgentActionKind;
  rationale: string;
  strategySource: 'heuristic' | 'llm';
  toolName?: string;
  targetBundleIds: string[];
  args?: Record<string, unknown>;
  reasoning: string;
  decidedAt: string;
  resultSummary?: string;
}
