/**
 * Typed MCP tool response interfaces for the static-analyzer.
 *
 * These replace `any` returns in `StaticToolServices` and ensure
 * compile-time safety for both producer (service) and consumer (TUI).
 */

import type { FeasibleLeakPath, OwnershipSummary, AllocFreePair } from '@cleak/common/types';

// ─── Shared sub-types ───────────────────────────────────────────────

export interface ScanBuildFinding {
  id: string;
  file_path: string;
  line_number: number;
  function_name: string;
  allocation_type: string;
  confidence: 'high' | 'medium' | 'low';
  context: string;
}

// ─── indexFiles ─────────────────────────────────────────────────────

export interface RepoIndexResponse {
  files: string[];
  totalCount: number;
  errors: string[];
}

// ─── candidateScan ──────────────────────────────────────────────────

export interface CandidateEntry {
  id: string;
  functionName: string | null;
  filePath: string;
  lineNumber: number;
  allocationSite: string;
  allocationType: string;
  confidence: string;
  context: string;
  signature: string;
  observedDeallocationCount: number;
  earlyReturnLines: number[];
}

export interface CandidateScanResponse {
  candidates: CandidateEntry[];
}

// ─── astScan ────────────────────────────────────────────────────────

export interface MemoryPattern {
  patternType: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  functionName: string;
  filePath: string;
  lineNumber: number;
  description: string;
  explanation: string;
  allocationType: string;
  allocationVariable?: string;
  allocationLine?: number;
  suggestedFix?: string;
}

export interface FunctionScanSummary {
  functionName: string;
  filePath: string;
  lineNumber: number;
  totalAllocs: number;
  totalFrees: number;
  allocFreeRatio: number;
  hasLeakPatterns: boolean;
  patternCount: number;
  earlyReturnCount: number;
  loopCount: number;
  loopsWithAllocations: number;
  exitPathCount: number;
  leakyExitPaths: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface AstScanResponse {
  patterns: MemoryPattern[];
  functionSummaries: FunctionScanSummary[];
}

// ─── callGraph ──────────────────────────────────────────────────────

export interface CallEdge {
  caller: string;
  callee: string;
  filePath: string;
  lineNumber: number;
  callee_file?: string;
}

export interface CallGraphNode {
  functionName: string;
  filePath: string;
}

export interface AllocFreeChain {
  allocFunction: string;
  freeFunction: string;
  callers: string[];
}

export interface CallGraphStats {
  totalFunctions: number;
  totalEdges: number;
  internalEdges: number;
  externalCalls: number;
  recursionCycles: number;
}

export interface CallGraphResponse {
  edges: CallEdge[];
  nodes: CallGraphNode[];
  recursionCycles: string[][];
  allocFreeChains: AllocFreeChain[];
  stats: CallGraphStats;
}

// ─── functionSummary ────────────────────────────────────────────────

export interface FunctionSummaryEntry {
  function_name: string;
  parameter_count: number;
  local_variable_count: number;
  call_count: number;
  allocation_count: number;
  deallocation_count: number;
  return_count: number;
  leaked_variables: { variable: string; line: number; callName: string }[];
  nonlocal_allocations: { variable: string; line: number; callName: string }[];
  has_allocation_without_local_free: boolean;
  exit_path_count: number;
  leaky_exit_paths: number;
  loop_count: number;
  loops_with_allocations: number;
  gotos: number;
  severtiy: string;
}

export interface FunctionSummaryResponse {
  summary: string;
  allocations: string[];
  frees: string[];
  pairs: AllocFreePair[];
}

// ─── interproceduralFlow ────────────────────────────────────────────

export interface FlowPath {
  functionName: string;
  filePath: string;
  lines: number[];
  allocs: string[];
  frees: string[];
  hasAllocWithoutFree: boolean;
}

export interface OwnershipChain {
  function: string;
  file: string;
  allocCount: number;
  freeCount: number;
  chain: string;
}

export interface InterproceduralFlowResponse {
  paths: FlowPath[];
  freeParameters: string[];
  reachableFrees: string[];
  ownershipChains: OwnershipChain[];
  depth: number;
  hasLeak: boolean;
  startFunction: string;
  unreconciledAllocVars: string[];
}

// ─── pathConstraints ────────────────────────────────────────────────

export interface FeasiblePath {
  kind: string;
  line: number;
  leakRisk: string;
  conditions: string[];
  allocatedNotFreed: string[];
}

export interface ExitPathInfo {
  kind: string;
  exitLine: number;
  hasFreeOnPath: boolean;
  freeLines: number[];
  leakRisk: string;
  unreconciledAllocations: string[];
}

export interface PathConstraintsResponse {
  constraints: string[];
  feasiblePaths: FeasiblePath[];
  feasibleLeakPaths?: FeasibleLeakPath[];
  exitPaths: ExitPathInfo[];
  pathsToTarget?: string[];
  containsEarlyReturn?: boolean;
  earlyReturnCount?: number;
  totalExitPaths?: number;
  leakyExitPaths?: number;
}

// ─── ownershipSummary ───────────────────────────────────────────────

export interface OwnershipEntry {
  functionName: string;
  filePath: string;
  ownershipType: string;
  allocatedObjects: string[];
  leakPaths: number;
  leakRisk: string;
  summary: OwnershipSummary;
}

export interface OwnershipSummaryResponse {
  ownerships: OwnershipEntry[];
}

// ─── ownershipConventions ───────────────────────────────────────────

export interface ConventionRule {
  pattern: string;
  description: string;
  conventionType: string;
}

export interface OwnershipConventionsResponse {
  rules: ConventionRule[];
}

// ─── scanBuildRun ───────────────────────────────────────────────────

export interface ScanBuildRunResponse {
  success: boolean;
  runId: string;
  output: string;
}

// ─── scanBuildGetReport ─────────────────────────────────────────────

export interface ScanBuildReportResponse {
  report: string;
  findings: ScanBuildFinding[];
}

// ─── Union of all static MCP responses ──────────────────────────────

export type StaticMcpResponse =
  | RepoIndexResponse
  | CandidateScanResponse
  | AstScanResponse
  | CallGraphResponse
  | FunctionSummaryResponse
  | InterproceduralFlowResponse
  | PathConstraintsResponse
  | OwnershipSummaryResponse
  | OwnershipConventionsResponse
  | ScanBuildRunResponse
  | ScanBuildReportResponse;
