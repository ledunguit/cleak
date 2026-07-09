import type { AgentActionKind } from './enums';
import type { LeakBundle } from './candidate';

// ── Tool execution ──

export interface ToolExecutionRecord {
  toolName: string;
  phase: string;
  status: 'success' | 'failed' | 'skipped';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  error?: string;
}

// ── Investigation planning ──

export interface InvestigationPlan {
  strategySource: 'heuristic' | 'llm';
  focusBundleIds: string[];
  staticToolSequence: string[];
  runScanBuild: boolean;
  runDynamic: boolean;
  dynamicToolPreference?: string;
  bundleLimit?: number;
  rationale: string;
  notes: string[];
}

export type InvestigationActionKind = 'run_static_tool' | 'run_scan_build' | 'run_dynamic' | 'finish';

export interface InvestigationNextAction {
  kind: InvestigationActionKind;
  stage: string;
  strategySource: 'heuristic' | 'llm';
  rationale: string;
  targetBundleIds: string[];
  toolName?: string;
}

export interface InvestigationPlanningRecord {
  stage: string;
  replannedAt: string;
  strategySource: 'heuristic' | 'llm';
  rationale: string;
  notes: string[];
  staticToolSequence: string[];
  runScanBuild: boolean;
  runDynamic: boolean;
  dynamicToolPreference?: string;
  focusBundleCount: number;
}

export interface InvestigationActionRecord {
  kind: InvestigationActionKind;
  stage: string;
  decidedAt: string;
  strategySource: 'heuristic' | 'llm';
  rationale: string;
  targetBundleCount: number;
  toolName?: string;
}

// ── Agentic orchestrator state ──

export interface AgentLoopState {
  scanId: string;
  phase: 'discovery' | 'candidate_ranking' | 'investigation' | 'judging' | 'reporting' | 'completed' | 'failed';
  bundles: LeakBundle[];
  toolExecutions: ToolExecutionRecord[];
  focusBundleIds: string[];
  actionsTaken: AgentDecision[];
  currentStrategy: string;
  llmContext: string;
  startedAt: string;
  maxInvestigationLoops: number;
  investigationCount: number;
}

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

export interface ToolCost {
  name: string;
  phase: string;
  description: string;
  typicalDurationMs: number;
  prerequisites: string[];
  providesEvidenceFor: string[];
}

export interface OrchestratorSystemPrompt {
  role: string;
  mission: string;
  tools: ToolCost[];
  strategy_guide: string;
  chain_of_thought_instructions: string;
  output_format: string;
}
