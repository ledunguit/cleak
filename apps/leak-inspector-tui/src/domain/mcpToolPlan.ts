/**
 * Per-tool execution policy for the analyzer MCP tools. The analyzers don't set
 * MCP read-only/destructive annotations, so we classify them here: pure static
 * queries are read-only AND concurrency-safe (cheap, no side effects); tools
 * that spawn builds, sanitizer runs, or scan-build are read-only but NOT
 * concurrency-safe (heavy, must run serially). Also maps each MCP tool name to
 * a ScanPhase for event tagging on the timeline.
 */

import { ScanPhase } from '@cleak/common/flow/scan-flow-contract';
import type { McpToolFlags } from '@cleak/agent-core';

/** Tools that are fast, pure, side-effect-free → safe to batch concurrently. */
const CONCURRENCY_SAFE = new Set<string>([
  'indexFiles',
  'candidateScan',
  'astScan',
  'callGraph',
  'functionSummary',
  'interproceduralFlow',
  'pathConstraints',
  'ownershipSummary',
  'ownershipConventions',
  'leakguardGetReport',
  'valgrindGetReport',
  'valgrindListFindings',
  'valgrindCompareRuns',
  'listRuns',
]);

/** Heavy/process-spawning tools — read-only w.r.t. source, but must run serially. */
const SERIAL_HEAVY = new Set<string>([
  'leakguardRun',
  'buildTarget',
  'valgrindMemcheck',
  'asanRun',
  'lsanRun',
  'runBinary',
]);

// Analyzer outputs (AST dumps, flow graphs) are verbose; cap them so the agent
// context stays small enough for local models with limited context windows.
const MAX_RESULT_CHARS = 6000;

export function mcpToolFlags(toolName: string): McpToolFlags {
  if (CONCURRENCY_SAFE.has(toolName)) {
    return { readOnly: true, concurrencySafe: true, maxResultChars: MAX_RESULT_CHARS, timeoutMs: 30_000 };
  }
  // Heavy tools build/run code (sanitizers, scan-build, valgrind) — serial, need
  // interactive approval (TUI), and a long timeout (builds can take minutes).
  if (SERIAL_HEAVY.has(toolName)) {
    return { readOnly: true, concurrencySafe: false, ask: true, maxResultChars: MAX_RESULT_CHARS, timeoutMs: 300_000 };
  }
  // Unknown tool: fail-closed to serial, still read-only (analysis servers don't write source).
  return { readOnly: true, concurrencySafe: false, maxResultChars: MAX_RESULT_CHARS, timeoutMs: 30_000 };
}

/** camelCase MCP tool name → ScanPhase (companion to scan-flow-contract's TOOL_PHASE). */
export const MCP_TOOL_PHASE: Record<string, ScanPhase> = {
  indexFiles: ScanPhase.DISCOVERY,
  candidateScan: ScanPhase.DISCOVERY,
  astScan: ScanPhase.INVESTIGATION,
  callGraph: ScanPhase.INVESTIGATION,
  functionSummary: ScanPhase.INVESTIGATION,
  interproceduralFlow: ScanPhase.INVESTIGATION,
  pathConstraints: ScanPhase.INVESTIGATION,
  ownershipSummary: ScanPhase.INVESTIGATION,
  ownershipConventions: ScanPhase.INVESTIGATION,
  leakguardRun: ScanPhase.LEAKGUARD,
  leakguardGetReport: ScanPhase.LEAKGUARD,
  buildTarget: ScanPhase.DYNAMIC,
  valgrindMemcheck: ScanPhase.DYNAMIC,
  valgrindGetReport: ScanPhase.DYNAMIC,
  valgrindListFindings: ScanPhase.DYNAMIC,
  valgrindCompareRuns: ScanPhase.DYNAMIC,
  asanRun: ScanPhase.DYNAMIC,
  lsanRun: ScanPhase.DYNAMIC,
  runBinary: ScanPhase.DYNAMIC,
  listRuns: ScanPhase.DYNAMIC,
};

export function phaseForMcpTool(toolName: string): ScanPhase | undefined {
  return MCP_TOOL_PHASE[toolName];
}

export type ToolSource = 'mcp-static' | 'mcp-dynamic' | 'local';

/** Classify a tool by where it runs: the static/dynamic analyzer (MCP) or a local domain tool. */
export function toolSource(toolName: string): ToolSource {
  if ((DYNAMIC_TOOL_NAMES as readonly string[]).includes(toolName)) return 'mcp-dynamic';
  if ((STATIC_TOOL_NAMES as readonly string[]).includes(toolName) || MCP_TOOL_PHASE[toolName]) return 'mcp-static';
  return 'local';
}

/**
 * Static-analyzer tools that accept file CONTENT (so the orchestrator can pass
 * host file content instead of relying on a shared filesystem). These are the
 * only static tools exposed to the agent — the multi-file / filesystem tools
 * (indexFiles, callGraph, interproceduralFlow, ownershipSummary, leakguard*)
 * need a shared mount and are excluded so the analyzer stays a stateless,
 * remote-deployable service.
 */
export const CONTENT_CAPABLE_TOOLS = new Set<string>([
  'candidateScan',
  'astScan',
  'functionSummary',
  'pathConstraints',
  'ownershipConventions',
]);

/** Static-analyzer tool names available without dynamic analysis. */
export const STATIC_TOOL_NAMES = [
  'indexFiles',
  'candidateScan',
  'astScan',
  'callGraph',
  'functionSummary',
  'interproceduralFlow',
  'pathConstraints',
  'ownershipSummary',
  'ownershipConventions',
  'leakguardRun',
  'leakguardGetReport',
] as const;

/** Dynamic-analyzer tool names (gated behind --dynamic). */
export const DYNAMIC_TOOL_NAMES = [
  'buildTarget',
  'valgrindMemcheck',
  'valgrindGetReport',
  'valgrindListFindings',
  'valgrindCompareRuns',
  'asanRun',
  'lsanRun',
  'runBinary',
  'listRuns',
] as const;
