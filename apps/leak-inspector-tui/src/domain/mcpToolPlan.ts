/**
 * Per-tool execution policy for the analyzer MCP tools. The analyzers don't set
 * MCP read-only/destructive annotations, so we classify them here: pure static
 * queries are read-only AND concurrency-safe (cheap, no side effects); tools
 * that spawn builds, sanitizer runs, or scan-build are read-only but NOT
 * concurrency-safe (heavy, must run serially). Also maps each MCP tool name to
 * a ScanPhase for event tagging on the timeline.
 */

import { ScanPhase } from '@cleak/common/flow/scan-flow-contract';
import { STATIC_TOOL_NAMES, DYNAMIC_TOOL_NAMES } from '@cleak/common/mcp/tool-catalog';
import type { McpToolFlags } from '@cleak/agent-core';

/** Tools that are fast, pure, side-effect-free → safe to batch concurrently. */
const CONCURRENCY_SAFE = new Set<string>([
  // Every static tool except the build-spawning scan-build run.
  ...STATIC_TOOL_NAMES.filter((name) => name !== 'scanBuildRun'),
  'valgrindGetReport',
  'valgrindListFindings',
  'valgrindCompareRuns',
  'listRuns',
]);

/** Heavy/process-spawning tools — read-only w.r.t. source, but must run serially. */
const SERIAL_HEAVY = new Set<string>([
  'scanBuildRun',
  ...DYNAMIC_TOOL_NAMES.filter((name) => !['valgrindGetReport', 'valgrindListFindings', 'valgrindCompareRuns', 'listRuns'].includes(name)),
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

/** camelCase MCP tool name → ScanPhase (the TUI's own phase map for tool sub-events). */
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
  scanBuildRun: ScanPhase.SCAN_BUILD,
  scanBuildGetReport: ScanPhase.SCAN_BUILD,
  buildTarget: ScanPhase.DYNAMIC,
  valgrindMemcheck: ScanPhase.DYNAMIC,
  valgrindGetReport: ScanPhase.DYNAMIC,
  valgrindListFindings: ScanPhase.DYNAMIC,
  valgrindCompareRuns: ScanPhase.DYNAMIC,
  asanRun: ScanPhase.DYNAMIC,
  lsanRun: ScanPhase.DYNAMIC,
  runBinary: ScanPhase.DYNAMIC,
  listRuns: ScanPhase.DYNAMIC,
  buildHarness: ScanPhase.DYNAMIC,
  libfuzzerRun: ScanPhase.DYNAMIC,
};

export function phaseForMcpTool(toolName: string): ScanPhase | undefined {
  return MCP_TOOL_PHASE[toolName];
}

export type ToolSource = 'mcp-static' | 'mcp-dynamic' | 'local';

/** Classify a tool by where it runs: the static/dynamic analyzer (MCP) or a local domain tool. */
export function toolSource(toolName: string): ToolSource {
  if (DYNAMIC_TOOL_NAMES.includes(toolName)) return 'mcp-dynamic';
  if (STATIC_TOOL_NAMES.includes(toolName) || MCP_TOOL_PHASE[toolName]) return 'mcp-static';
  return 'local';
}

