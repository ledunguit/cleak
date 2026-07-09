/**
 * Typed MCP tool response interfaces for the dynamic-analyzer.
 *
 * These replace `any` returns in `DynamicToolServices` and ensure
 * compile-time safety for both producer (service) and consumer (TUI).
 */

// ─── Shared sub-types ───────────────────────────────────────────────

export interface StackFrame {
  function: string | null;
  file: string | null;
  line: number | null;
}

/** Raw sanitizer finding from result-parser (ASan/LSan output). */
export interface RawFinding {
  kind: string;
  message: string;
  stack: StackFrame[];
  originStack: StackFrame[];
  aux: Record<string, unknown>;
}

/** Normalized leak finding (Valgrind Memcheck, after toLeakFinding). */
export interface LeakFinding {
  id: string;
  tool: string;
  runId: string;
  functionName: string;
  filePath: string;
  lineNumber: number;
  bytesLost: number;
  blocksLost: number;
  severity: string;
  stackTrace: string;
  allocationType: string;
  status: string;
}

export interface FindingSummary {
  findingCount: number;
  high: number;
  medium: number;
  low: number;
}

// ─── buildTarget ────────────────────────────────────────────────────

export interface BuildTargetResponse {
  success: boolean;
  binaryPath: string;
  buildLog: string;
  errors: string[];
  docker?: boolean;  // present when build used Docker
}

// ─── valgrindMemcheck ───────────────────────────────────────────────

export interface ValgrindMemcheckResponse {
  success: boolean;
  runId: string;
  findings: LeakFinding[];
  summary: FindingSummary | string;
}

// ─── valgrindGetReport ──────────────────────────────────────────────

export interface RunRecord {
  runId: string;
  tool: string;
  binaryPath: string;
  output: string;
  findings: LeakFinding[];
  success: boolean;
  createdAt: string;
}

export type ValgrindGetReportResponse = RunRecord | null;

// ─── valgrindListFindings ───────────────────────────────────────────

export interface ValgrindListFindingsResponse {
  findings: LeakFinding[];
}

// ─── valgrindCompareRuns ────────────────────────────────────────────

export interface ValgrindCompareRunsResponse {
  newFindings: LeakFinding[];
  fixedFindings: LeakFinding[];
  unchanged: LeakFinding[];
}

// ─── asanRun ────────────────────────────────────────────────────────

export interface AsanRunResponse {
  success: boolean;
  runId: string;
  findings: RawFinding[];
  rawOutput: string;
}

// ─── lsanRun ────────────────────────────────────────────────────────

export interface LsanRunResponse {
  success: boolean;
  runId: string;
  findings: RawFinding[];
  rawOutput: string;
}

// ─── runBinary ──────────────────────────────────────────────────────

export interface RunBinaryResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ─── listRuns ───────────────────────────────────────────────────────

export interface RunSummary {
  runId: string;
  tool: string;
  binaryPath: string;
  createdAt: string;
  success: boolean;
}

export interface ListRunsResponse {
  runs: RunSummary[];
}

// ─── Union of all dynamic MCP responses ─────────────────────────────

export type DynamicMcpResponse =
  | BuildTargetResponse
  | ValgrindMemcheckResponse
  | ValgrindGetReportResponse
  | ValgrindListFindingsResponse
  | ValgrindCompareRunsResponse
  | AsanRunResponse
  | LsanRunResponse
  | RunBinaryResponse
  | ListRunsResponse;
