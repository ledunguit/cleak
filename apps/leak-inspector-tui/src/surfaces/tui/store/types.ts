/**
 * Shared types for the TUI store domain sub-stores. Extracted from the
 * monolithic store.ts to allow focused imports without circular deps.
 */

import type { AgentMeta } from '../../../orchestrator/investigation';
import type { ToolSource } from '../../../domain/mcpToolPlan';
import type { EvalResult } from '../../../domain/evalHarness';
import type { SnapshotFinding, LabeledFlaw, CleanSite } from '../../../domain/evalScoring';
import type { ScanPhase } from '@cleak/common/flow/scan-flow-contract';
import type { FindingView } from '../findings/findingView';

export type PhaseStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';
export type RunStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';

export interface ToolCardData {
  name: string;
  title: string;
  source: ToolSource;
  status: 'running' | 'ok' | 'error';
  durationMs?: number;
  preview?: string;
  output?: string;
}

export interface UiMessage {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'phase' | 'thinking';
  text?: string;
  color?: string;
  tool?: ToolCardData;
  agentId: string;
  collapsed?: boolean;
}

export interface AgentInfo {
  id: string;
  label: string;
  kind: AgentMeta['kind'];
  status: 'running' | 'done' | 'error';
  turns: number;
}

export type NavMode = 'normal' | 'agentlist' | 'agentlog';

export interface PendingPermission {
  id: string;
  name: string;
  input: unknown;
  resolve: (decision: 'allow' | 'deny') => void;
}

export type EvalCaseStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped';

export interface EvalCaseUi {
  id: string;
  cwe?: string;
  flowVariant?: string;
  functionalVariant?: string;
  status: EvalCaseStatus;
  phase?: string;
  startedAt?: number;
  durationMs?: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  candidates?: number;
  flagged?: number;
  scanId?: string;
  error?: string;
  findings?: SnapshotFinding[];
  flaws?: LabeledFlaw[];
  clean?: CleanSite[];
}

export type EvalTab = 'overview' | 'cases' | 'detail';

export interface EvalUiState {
  corpus: string;
  mode: string;
  dynamic: string;
  total: number;
  done: number;
  concurrency: number;
  startedAt: number;
  finishedAt?: number;
  running: boolean;
  cancelling?: boolean;
  cases: EvalCaseUi[];
  tab: EvalTab;
  cursor: number;
  selectedId?: string;
  result?: EvalResult;
  outDir?: string;
}

export type FindingsTab = 'table' | 'detail';
export type FindingsSort = 'severity' | 'confidence' | 'file';

export interface FindingsUiState {
  scanId: string;
  source: 'live' | 'snapshot';
  findings: FindingView[];
  cursor: number;
  sort: FindingsSort;
  filter: { verdict?: string; coverage?: string };
  tab: FindingsTab;
  detailId?: string;
}

export interface UiState {
  messages: UiMessage[];
  phases: Record<ScanPhase, PhaseStatus>;
  currentPhase?: ScanPhase;
  status: RunStatus;
  statusText: string;
  usage: { inputTokens: number; outputTokens: number; thinkingTokens: number };
  io?: 'up' | 'down';
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  scanId?: string;
  reportDir?: string;
  summary?: { candidates: number; confirmed: number; likely: number };
  pendingPermission?: PendingPermission;
  permissionMode: 'ask' | 'auto';
  startedAt?: number;
  view: 'main' | 'config' | 'eval' | 'findings';
  eval?: EvalUiState;
  findings?: FindingsUiState;
  autoShowReport: boolean;
  ranDynamicTool: boolean;
  scrollOffset: number;
  agents: AgentInfo[];
  viewAgentId: string;
  navMode: NavMode;
  navIndex: number;
  focusMsgId?: string;
}

/** Read/write handle shared by all sub-stores. */
export interface StoreAccess {
  get: () => UiState;
  set: (patch: Partial<UiState>) => void;
}
