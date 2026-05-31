// ── Enums ──

export enum LeakConfidence {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

export enum InvestigationVerdict {
  CONFIRMED_LEAK = 'confirmed_leak',
  LIKELY_LEAK = 'likely_leak',
  UNCERTAIN = 'uncertain',
  LIKELY_FALSE_POSITIVE = 'likely_false_positive',
  FALSE_POSITIVE = 'false_positive',
}

export enum ToolKind {
  VALGRIND = 'valgrind',
  ASAN = 'asan',
  LSAN = 'lsan',
  LEAKGUARD = 'leakguard',
  HEURISTIC = 'heuristic',
  LLM = 'llm',
}

export enum AnalysisMode {
  NO_LLM = 'no_llm',
  LLM_ASSISTED = 'llm_assisted',
}

export enum DynamicMode {
  OFF = 'off',
  SELECTIVE = 'selective',
  AGGRESSIVE = 'aggressive',
}

export enum DynamicToolPreference {
  AUTO = 'auto',
  VALGRIND = 'valgrind',
  LSAN = 'lsan',
  ASAN = 'asan',
}

export enum ReportFormat {
  JSON = 'json',
  MARKDOWN = 'markdown',
  HTML = 'html',
  PDF = 'pdf',
  SNAPSHOT = 'snapshot',
}

export enum FindingStatus {
  PENDING = 'pending',
  INVESTIGATING = 'investigating',
  CONFIRMED = 'confirmed',
  DISMISSED = 'dismissed',
}

// ── Core Interfaces ──

export interface LeakCandidate {
  id: string;
  function_name: string;
  file_path: string;
  line_number: number;
  allocation_site: string;
  allocation_type: string;
  confidence: LeakConfidence;
  context: string;
}

export interface VerdictResult {
  verdict: InvestigationVerdict;
  confidence: number;
  explanation: string;
  evidence: string[];
  tool: ToolKind;
  repair_suggestion?: string;
  /** Structured root-cause classification (populated by the LLM judge). */
  rootCause?: LeakRootCause;
  /** Concrete before/after code fix (populated by the LLM judge). */
  repairDiff?: RepairDiff;
}

export interface LeakBundle {
  bundleId: string;
  candidate: LeakCandidate;
  verdict?: VerdictResult;
  evidence: LeakEvidence[];
  status: FindingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LeakEvidence {
  tool: ToolKind;
  runId: string;
  function_name: string;
  file_path: string;
  line_number: number;
  bytes_lost: number;
  blocks_lost: number;
  severity: string;
  stack_trace: string;
  raw_output: string;
}

export interface ScanMetadata {
  scanId: string;
  workspacePath: string;
  sourceWorkspacePath?: string;
  materializedWorkspacePath?: string;
  materializedWorkspaceId?: string;
  analysisMode: AnalysisMode;
  dynamicMode: DynamicMode;
  fileLimit: number;
  buildCommand?: string;
  workspaceId?: string;
  repoId?: string;
  startedAt: string;
  completedAt?: string;
  status: ScanStatus;
}

export enum ScanStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface ScanReport {
  scanId: string;
  metadata: ScanMetadata;
  bundles: LeakBundle[];
  summary: ReportSummary;
}

export interface ReportSummary {
  totalCandidates: number;
  confirmedLeaks: number;
  likelyLeaks: number;
  falsePositives: number;
  totalBytesLost: number;
  toolsUsed: ToolKind[];
  durationSec: number;
}

export interface AstNode {
  type: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  text: string;
  children: AstNode[];
}

export interface CallGraphEdge {
  caller: string;
  callee: string;
  filePath: string;
  lineNumber: number;
}

export interface CallGraphNode {
  functionName: string;
  filePath: string;
}

export interface FlowPath {
  functionName: string;
  filePath: string;
  lines: number[];
}

export interface OwnershipInfo {
  functionName: string;
  filePath: string;
  ownershipType: string;
  allocatedObjects: string[];
}

export interface OwnershipRule {
  pattern: string;
  description: string;
  conventionType: string;
}

// ── GitHub ──

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  name?: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  clone_url: string;
  private: boolean;
  default_branch: string;
  description?: string;
}

export interface GitHubBranch {
  name: string;
  commit_sha: string;
}

// ── Workspace ──

export interface WorkspaceInfo {
  workspaceId: string;
  name: string;
  path: string;
  c_cpp_file_count: number;
  source: 'filesystem' | 'github';
  repoId?: string;
  settings?: WorkspaceSettings;
  createdAt: string;
}

export interface WorkspaceSettings {
  analysisMode?: AnalysisMode;
  dynamicMode?: DynamicMode;
  fileLimit?: number;
  buildCommand?: string;
  dynamicToolPreference?: DynamicToolPreference;
  lsanEnabled?: boolean;
}

export interface BuildPlanEvidence {
  kind: 'build_file' | 'ci_file' | 'readme' | 'heuristic' | 'llm';
  path?: string;
  detail: string;
}

export interface RepositoryManifest {
  scanId?: string;
  materializedWorkspaceId?: string;
  workspaceId?: string | null;
  repoId?: string | null;
  sourceType: 'github' | 'upload_zip' | 'local_path' | 'workspace_path';
  sourcePath: string;
  materializedPath: string;
  analyzerVisiblePath?: string;
  createdAt: string;
  rootEntries: string[];
  buildFiles: string[];
  ciFiles: string[];
  readmeFiles: string[];
  sourceFileCount: number;
  languageHints: string[];
}

export interface BuildPlan {
  buildSystem: string;
  workingDirectory: string;
  configureCommand?: string;
  buildCommand: string;
  cleanCommand?: string;
  runCommand?: string;
  binaryCandidates: string[];
  compilerOverrides: Record<string, string>;
  sanitizerVariants: {
    default: string;
    asan?: string;
    lsan?: string;
    valgrind?: string;
  };
  requiredEnv: Record<string, string>;
  evidence: BuildPlanEvidence[];
  strategy: 'heuristic' | 'llm' | 'user';
}

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

export interface InvestigationPlan {
  strategySource: 'heuristic' | 'llm';
  focusBundleIds: string[];
  staticToolSequence: string[];
  runLeakguard: boolean;
  runDynamic: boolean;
  dynamicToolPreference?: string;
  bundleLimit?: number;
  rationale: string;
  notes: string[];
}

export type InvestigationActionKind = 'run_static_tool' | 'run_leakguard' | 'run_dynamic' | 'finish';

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
  runLeakguard: boolean;
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

// ── Agentic Orchestrator: Extended Types ──

export enum LeakPatternType {
  EARLY_RETURN = 'early_return',
  CONDITIONAL_LEAK = 'conditional_leak',
  LOOP_ACCUMULATE = 'loop_accumulate',
  DOUBLE_FREE = 'double_free',
  USE_AFTER_FREE = 'use_after_free',
  STRDUP_LEAK = 'strdup_leak',
  STRUCT_FIELD_LEAK = 'struct_field_leak',
  REALLOC_MISHANDLE = 'realloc_mishandle',
  MISSING_NULL_CHECK = 'missing_null_check',
  INTERPROCEDURAL_LEAK = 'interprocedural_leak',
  ARRAY_LEAK = 'array_leak',
  CUSTOM_ALLOCATOR_LEAK = 'custom_allocator_leak',
  UNKNOWN = 'unknown',
}

export enum AgentActionKind {
  RUN_STATIC_TOOL = 'run_static_tool',
  RUN_LEAKGUARD = 'run_leakguard',
  RUN_DYNAMIC = 'run_dynamic',
  JUDGE_BUNDLE = 'judge_bundle',
  REQUEST_MORE_EVIDENCE = 'request_more_evidence',
  DEEP_INVESTIGATE = 'deep_investigate',
  CHANGE_STRATEGY = 'change_strategy',
  FINISH = 'finish',
}

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

export interface ControlFlowInfo {
  functionName: string;
  filePath: string;
  lineNumber: number;
  hasAllocation: boolean;
  allocationLines: number[];
  freeLines: number[];
  exitPaths: ExitPathInfo[];
  earlyReturnLines: number[];
  conditionalBranches: { line: number; text: string }[];
  loops: { line: number; text: string }[];
  hasMallocInLoop: boolean;
  matchedFreeRatio: number;
}

export interface ExitPathInfo {
  kind: 'return' | 'goto' | 'exit' | 'longjmp' | 'fallthrough';
  line: number;
  hasFreeBeforeExit: boolean;
  conditions: string[];
  freeLinesBeforeExit: number[];
  leakRisk: 'high' | 'medium' | 'low' | 'none';
}

export interface LeakRootCause {
  patternType: LeakPatternType;
  description: string;
  allocationFunction: string;
  allocationLine: number;
  allocationFile: string;
  missingFreeLine?: number;
  missingFreeFunction?: string;
  rootCauseFunction: string;
  rootCauseLine: number;
  rootCauseDescription: string;
}

export interface LeakExplanation {
  rootCause: LeakRootCause;
  summary: string;
  detailedExplanation: string;
  codeFlow: string[];
  repairSuggestion: string;
  repairDiff?: RepairDiff;
}

export interface RepairDiff {
  filePath: string;
  originalLines: string[];
  suggestedLines: string[];
  startLine: number;
  description: string;
}

export interface MemoryLeakAnalysis {
  bundleId: string;
  candidate: LeakCandidate;
  controlFlow: ControlFlowInfo;
  patternTypes: LeakPatternType[];
  rootCause?: LeakRootCause;
  explanation?: LeakExplanation;
  evidence: LeakEvidence[];
  verdict?: VerdictResult;
}

export interface OrchestratorSystemPrompt {
  role: string;
  mission: string;
  tools: ToolCost[];
  strategy_guide: string;
  chain_of_thought_instructions: string;
  output_format: string;
}

