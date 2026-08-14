/**
 * Server-side (analyzer) structured-log event vocabulary — the single source of
 * truth for `packages/observability` (mechanism: pino + AsyncLocalStorage) and
 * both analyzer apps' service instrumentation.
 *
 * MUST stay pure TypeScript: no NestJS / Node / pino imports, so `@cleak/common`
 * stays bundleable by any consumer — mirrors the same constraint documented on
 * `flow/scan-flow-contract.ts` (the analogous vocabulary for the TUI orchestrator's
 * client-side scan events; this file is that idiom's server-side counterpart).
 */
export enum ServerEventName {
  // ── MCP transport lifecycle (mcp-http.ts, one line per HTTP request) ──
  MCP_REQUEST_RECEIVED = 'mcp_request_received',
  MCP_REQUEST_REJECTED = 'mcp_request_rejected',
  MCP_REQUEST_COMPLETED = 'mcp_request_completed',
  MCP_REQUEST_ERRORED = 'mcp_request_errored',

  // ── MCP tool lifecycle (tool-instrumentation.ts, uniform across all 21 tools) ──
  MCP_TOOL_STARTED = 'mcp_tool_started',
  MCP_TOOL_FINISHED = 'mcp_tool_finished',
  MCP_TOOL_FAILED = 'mcp_tool_failed',

  // ── static-analyzer service-level ──
  INDEX_STARTED = 'index_started',
  INDEX_FINISHED = 'index_finished',
  CANDIDATE_SCAN_STARTED = 'candidate_scan_started',
  CANDIDATE_SCAN_FINISHED = 'candidate_scan_finished',
  AST_PARSE_STARTED = 'ast_parse_started',
  AST_PARSE_FINISHED = 'ast_parse_finished',
  AST_PARSE_FAILED = 'ast_parse_failed',
  CALL_GRAPH_STARTED = 'call_graph_started',
  CALL_GRAPH_FINISHED = 'call_graph_finished',
  FUNCTION_SUMMARY_STARTED = 'function_summary_started',
  FUNCTION_SUMMARY_FINISHED = 'function_summary_finished',
  FUNCTION_NOT_FOUND = 'function_not_found',
  FLOW_ANALYSIS_STARTED = 'flow_analysis_started',
  FLOW_ANALYSIS_FINISHED = 'flow_analysis_finished',
  PATH_CONSTRAINTS_STARTED = 'path_constraints_started',
  PATH_CONSTRAINTS_FINISHED = 'path_constraints_finished',
  OWNERSHIP_SUMMARY_STARTED = 'ownership_summary_started',
  OWNERSHIP_SUMMARY_FINISHED = 'ownership_summary_finished',
  OWNERSHIP_CONVENTIONS_STARTED = 'ownership_conventions_started',
  OWNERSHIP_CONVENTIONS_FINISHED = 'ownership_conventions_finished',
  SCAN_BUILD_STARTED = 'scan_build_started',
  SCAN_BUILD_FINISHED = 'scan_build_finished',
  SCAN_BUILD_FAILED = 'scan_build_failed',
  SCAN_BUILD_REPORT_READ = 'scan_build_report_read',

  // ── dynamic-analyzer service-level ──
  BUILD_STARTED = 'build_started',
  BUILD_SUCCEEDED = 'build_succeeded',
  BUILD_FAILED = 'build_failed',
  BUILD_DOCKER_STARTED = 'build_docker_started',
  SANITIZER_RUN_STARTED = 'sanitizer_run_started',
  SANITIZER_RUN_FINISHED = 'sanitizer_run_finished',
  SANITIZER_RUN_FAILED = 'sanitizer_run_failed',
  FINDINGS_READ = 'findings_read',
  RUN_COMPARE_STARTED = 'run_compare_started',
  RUN_COMPARE_FINISHED = 'run_compare_finished',
  BINARY_RUN_STARTED = 'binary_run_started',
  BINARY_RUN_FINISHED = 'binary_run_finished',
  RUN_SAVED = 'run_saved',
  RUN_READ = 'run_read',
  RUN_READ_CORRUPT = 'run_read_corrupt',
  RUNS_LISTED = 'runs_listed',
  HARNESS_BUILD_STARTED = 'harness_build_started',
  HARNESS_BUILD_FINISHED = 'harness_build_finished',
  HARNESS_BUILD_FAILED = 'harness_build_failed',
  FUZZER_RUN_STARTED = 'fuzzer_run_started',
  FUZZER_RUN_FINISHED = 'fuzzer_run_finished',
  EXEC_CONFINED_STARTED = 'exec_confined_started',
  EXEC_CONFINED_FINISHED = 'exec_confined_finished',
  PATH_REJECTED = 'path_rejected',
}

/** Which sanitizer produced a `SANITIZER_RUN_*` event — a field value, not a separate event set. */
export type SanitizerKind = 'valgrind' | 'asan' | 'lsan' | 'none';
