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

/** A caller passes a heap-allocated variable into a callee parameter that the
 * callee frees — cross-function/cross-file ownership transfer (Juliet flow-
 * variant ≥21: "sink functions are in a separate file from sources"). For a
 * multi-hop chain (flow-variant 51-54), `calleeFunction`/`calleeFile`/
 * `calleeParam` name the LAST hop that actually frees, not the immediate
 * callee. For a container-transported value (flow-variant 72-74, `kind:
 * 'container'`), `calleeParam` names the LOCAL VARIABLE the callee extracted
 * the value into (e.g. `char *data = dataVector[2];`), not a parameter name. */
export interface FreedCrossFileEntry {
  callerFunction: string;
  callerFile: string;
  callerVariable: string;
  callerAllocLine: number;
  calleeFunction: string;
  calleeFile: string;
  calleeParam: string;
  /** 'container' when the value traveled through a vector/list/map insert+
   * extract rather than a bare parameter. Absent ⇒ 'parameter' (the original,
   * still-default shape). */
  kind?: 'parameter' | 'container';
}

/** A caller passes a heap-allocated variable into a callee pointer parameter
 * that is never freed on any path in the callee — an unconditional-loss sink,
 * deduped one entry per (calleeFile, calleeFunction, calleeParam). For a
 * multi-hop chain, this names the chain's TERMINAL function (the one that
 * doesn't forward further), not the immediate callee — a pass-through hop in
 * between is not itself the sink. `calleeSigLine` is the callee's function
 * signature line normally, or (`kind: 'container'`) the line where the
 * callee extracted the value out of the container. */
export interface UnfreedSinkParamEntry {
  calleeFunction: string;
  calleeFile: string;
  calleeParam: string;
  calleeSigLine: number;
  callerFunction: string;
  callerFile: string;
  callerVariable: string;
  kind?: 'parameter' | 'container';
}

/** A caller assigns a local variable from a callee's RETURN VALUE, and the
 * callee provably allocates-and-returns that value (no local free) — the
 * MIRROR of `FreedCrossFileEntry`/`UnfreedSinkParamEntry` for the opposite
 * data-flow direction (Juliet flow-variant 42-45/61-68: a function allocates
 * and RETURNS a pointer, rather than receiving one as a parameter). This
 * entry says the CALLER frees the assigned variable — exonerates the
 * callee's own allocation-site candidate (see `crossFileFreedVia` /
 * `freedViaCallee` in packages/common's heuristic-leak-analysis.ts). */
export interface FreedViaCallerEntry {
  calleeFunction: string;
  calleeFile: string;
  /** The variable name inside the callee that is allocated and returned. */
  variable: string;
  callerFunction: string;
  callerFile: string;
}

/** A caller assigns a local variable from a callee's RETURN VALUE (a known
 * allocate-and-return function) and never frees that local variable — the
 * dispatcher never gets a candidate today (no direct allocation call, no
 * pointer parameter), so this synthesizes one anchored at the caller's
 * assignment line. Deduped one entry per (callerFile, callerFunction,
 * callerVariable, callerAssignLine) since the SAME dispatcher is the actual
 * flaw site, not the (already-candidate) allocating callee. */
export interface UnfreedReturnOwnershipEntry {
  callerFunction: string;
  callerFile: string;
  callerVariable: string;
  callerAssignLine: number;
  calleeFunction: string;
  calleeFile: string;
}

export interface OwnershipCorrelations {
  freedCrossFile: FreedCrossFileEntry[];
  unfreedSinkParams: UnfreedSinkParamEntry[];
  freedViaCaller: FreedViaCallerEntry[];
  unfreedReturnOwnership: UnfreedReturnOwnershipEntry[];
}

export interface CallGraphResponse {
  edges: CallEdge[];
  nodes: CallGraphNode[];
  recursionCycles: string[][];
  allocFreeChains: AllocFreeChain[];
  stats: CallGraphStats;
  ownershipCorrelations: OwnershipCorrelations;
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
