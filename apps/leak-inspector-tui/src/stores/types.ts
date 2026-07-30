/**
 * Shared types for the TUI store domain sub-stores. Extracted from the
 * monolithic store.ts to allow focused imports without circular deps.
 *
 * This is the canonical location for store types as part of the Zustand
 * refactor. Old surfaces/tui/store/types.ts remains for backward compat
 * during migration.
 */

import type { AgentMeta } from '../orchestrator/investigation';
import type { ToolSource } from '../domain/mcpToolPlan';
import type { EvalResult } from '../domain/evalHarness';
import type { SnapshotFinding, LabeledFlaw, CleanSite } from '../domain/evalScoring';
import type { ScanPhase } from '@cleak/common/flow/scan-flow-contract';
import type { FindingView } from '../surfaces/tui/findings/findingView';

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

export interface AgentActivityMessage {
  kind: 'agent_activity';
  activityType: 'calling_mcp' | 'reading_file' | 'thinking' | 'planning' | 'done';
  text: string;
  agentId: string;
}

export interface UiMessage {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'phase' | 'thinking' | 'agent_activity';
  text?: string;
  color?: string;
  tool?: ToolCardData;
  agentId: string;
  collapsed?: boolean;
  activityType?: 'calling_mcp' | 'reading_file' | 'thinking' | 'planning' | 'done';
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
  /** What subset of the corpus this run covers — self-documenting run-summary
   * line in the header, without opening metrics.json. */
  sampling?: { mode: 'all' | 'topN' | 'random' | 'stratified'; limit?: number; randomSeed?: number; stratifyKey?: string };
  /** True when this run bypassed the corpus integrity gate — surfaced as a
   * persistent warning banner so a number is never silently ambiguous about
   * its trust level. */
  allowUnvalidated?: boolean;
  /** True when this state was loaded read-only via `/eval history`/`/eval
   * <name>` rather than a live run — changes what Esc does (back to the
   * history list instead of the main screen). */
  historical?: boolean;
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
  view: 'main' | 'config' | 'eval' | 'evalSetup' | 'findings';
  eval?: EvalUiState;
  findings?: FindingsUiState;
  autoShowReport: boolean;
  fullscreen: boolean;
  sidebarPosition: 'left' | 'right';
  ranDynamicTool: boolean;
  scrollOffset: number;
  agents: AgentInfo[];
  viewAgentId: string;
  navMode: NavMode;
  navIndex: number;
  focusMsgId?: string;
}
