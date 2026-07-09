import type { DynamicLeakKind, ToolKind } from './enums';

/** How a dynamic finding's allocation site was matched to a static candidate. */
export type CorrelationMethod =
  | 'file_line_exact'
  | 'file_line_near'
  | 'function_match'
  | 'file_only'
  | 'none';

/**
 * What a dynamic run actually established for a candidate — set DETERMINISTICALLY
 * after the dynamic stage (not inferred from `evidence.length`, which conflates
 * "ran clean" with "never ran"). `exercised_clean` requires a successful run that
 * covered the candidate's code and produced no correlated leak — the honest signal
 * the judge's precision gate needs.
 */
export type DynamicCoverage =
  | 'exercised_clean'
  | 'exercised_leak'
  | 'not_exercised'
  | 'dynamic_off';

/** A single frame of a dynamic allocation/leak backtrace. */
export interface StackFrameRef {
  function: string | null;
  file: string | null;
  line: number | null;
  /** false for libc/allocator internals (malloc, calloc, operator new …). */
  isUserFrame: boolean;
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
  // ── Enriched dynamic evidence (all optional / additive) ──
  /** Calibrated leak taxonomy (Valgrind kind or ASan/LSan bucket). */
  leakKind?: DynamicLeakKind;
  /** Full allocation backtrace, user + library frames preserved. */
  allocStack?: StackFrameRef[];
  /** First user frame of the allocation backtrace — the alloc site. */
  allocSite?: { file: string; line: number; function: string };
  /** SHA1 dedup signature from the normalizer. */
  signature?: string;
  /** True once the cross-correlation step links this finding to its candidate. */
  correlatedToCandidate?: boolean;
  /** How the link was established (exact line, near, function, file, none). */
  correlationMethod?: CorrelationMethod;
  /** |alloc line − candidate line| when both are known. */
  correlationDistanceLines?: number;
  /**
   * Graded 0..1 link strength (method + line distance + allocator-family
   * agreement), a finer signal than the `correlatedToCandidate` boolean. Used to
   * break ties when a finding could attach to more than one nearby candidate.
   */
  correlationConfidence?: number;
}

// ── Static evidence artifacts (research: MemHint / LAMeD) ──

/**
 * Ownership-explicit function summary: classifies a function and states which
 * value carries memory ownership. The single highest-value static artifact for
 * the LLM judge.
 */
export interface OwnershipSummary {
  functionName: string;
  filePath: string;
  role: 'allocator' | 'deallocator' | 'neither' | 'both';
  /** Which value carries ownership out of the function. */
  ownershipCarrier:
    | { kind: 'return_value' }
    | { kind: 'parameter'; name: string; index: number }
    | { kind: 'none' };
  /** Legacy coarse type: returns_ownership / consumes_ownership / local_ownership / none. */
  ownershipType: string;
  rationale: string;
}

/** An allocation paired with its corresponding free (or null when unpaired). */
export interface AllocFreePair {
  variable: string;
  allocCall: string;
  allocLine: number;
  allocFile: string;
  freeLine: number | null;
  freeFunction: string | null;
  /** LAMeD post-filter: the alloc binds to a NEW variable, not an existing object. */
  bindsToNewVariable: boolean;
  /** paired = freed on all paths; unpaired = never freed; conditional = freed on some paths only. */
  status: 'paired' | 'unpaired' | 'conditional';
}

/** A feasible (reachable) exit path that leaves an allocation un-freed. */
export interface FeasibleLeakPath {
  kind: 'return' | 'goto' | 'exit' | 'longjmp' | 'fallthrough';
  exitLine: number;
  reachable: boolean;
  conditions: string[];
  unreconciledAllocations: string[];
  leakRisk: 'high' | 'medium' | 'low' | 'none';
  /** Human/LLM-readable alloc→exit-without-free story. */
  narrative: string;
  feasibilityChecked: 'heuristic' | 'none';
}

/** A single Clang `scan-build` diagnostic, matched to a candidate as a second static opinion. */
export interface ScanBuildDiagnostic {
  file: string;
  line: number;
  message: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface StaticLeakEvidence {
  ownership?: OwnershipSummary;
  allocFreePairs: AllocFreePair[];
  feasibleLeakPaths: FeasibleLeakPath[];
  earlyReturnCount: number;
  leakyExitPaths: number;
  /** Project-level Clang scan-build diagnostics in the candidate's file (opt-in
   * `--static-tools scanBuild`). A diagnostic near the candidate corroborates the
   * heuristic — a deterministic second static opinion. Absent unless scanBuild ran. */
  scanBuildDiagnostics?: ScanBuildDiagnostic[];
}

// ── Control-flow evidence ──

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
