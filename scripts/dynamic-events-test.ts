#!/usr/bin/env bun
/**
 * Verifies M6 wiring without a Linux/Docker dynamic environment:
 *  (1) the agent-event → scan-event bridge emits the right scan-build/dynamic
 *      phase events for a synthetic tool sequence;
 *  (2) the dynamic analyzer's tools load and the heavy ones are flagged `ask`.
 */

import type { AgentEvent } from '@cleak/agent-core';
import { McpClient } from '@cleak/agent-core';
import { ScanEmitter, type EventSink, type ScanEvent } from '../apps/leak-inspector-tui/src/orchestrator/events';
import { makeAgentEventHandler } from '../apps/leak-inspector-tui/src/orchestrator/toAgentEvents';
import { loadMcpTools, wrapMcpTool } from '@cleak/agent-core';
import { mcpToolFlags } from '../apps/leak-inspector-tui/src/domain/mcpToolPlan';

const fail = (m: string) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

// ── (1) Event bridge ──
const emitted: string[] = [];
const sink: EventSink = { emit: (e: ScanEvent) => emitted.push(e.name) };
const emitter = new ScanEmitter(sink);
const bridge = makeAgentEventHandler(emitter);

const seq: AgentEvent[] = [
  { type: 'tool_use', id: '1', name: 'scanBuildRun', input: {}, isReadOnly: true },
  { type: 'tool_result', id: '1', name: 'scanBuildRun', output: {}, isError: false, durationMs: 10 },
  { type: 'tool_use', id: '2', name: 'buildTarget', input: {}, isReadOnly: true },
  { type: 'tool_result', id: '2', name: 'buildTarget', output: {}, isError: false, durationMs: 20 },
  { type: 'tool_use', id: '3', name: 'asanRun', input: {}, isReadOnly: true },
  { type: 'tool_result', id: '3', name: 'asanRun', output: {}, isError: false, durationMs: 30 },
];
for (const ev of seq) bridge.handle(ev);
bridge.finishPendingPhases();

const want = [
  'scan_build_started',
  'agent_tool_result',
  'dynamic_started',
  'dynamic_build_started',
  'agent_tool_result',
  'dynamic_binary_built',
  'agent_tool_result',
  'dynamic_tool_result',
  'dynamic_finished',
  'scan_build_finished',
];
for (const w of want) if (!emitted.includes(w)) fail(`expected event '${w}' not emitted. got: ${emitted.join(', ')}`);
// dynamic_started must fire exactly once (not per dynamic tool)
if (emitted.filter((e) => e === 'dynamic_started').length !== 1) fail('dynamic_started should fire exactly once');
console.log(`✓ event bridge: ${emitted.length} events, all scan-build/dynamic phase events present`);

// ── (2) Dynamic tools load + flags ──
const dynUrl = process.env.SMOKE_DYNAMIC_URL ?? 'http://127.0.0.1:50072/mcp';
const client = new McpClient(dynUrl, 'dynamic');
try {
  const tools = await loadMcpTools(client, mcpToolFlags);
  if (tools.length !== 9) fail(`expected 9 dynamic tools, got ${tools.length}`);
  const buildTool = tools.find((t) => t.name === 'buildTarget');
  const askPerm = buildTool ? (await buildTool.checkPermissions({}, {})).behavior : 'allow';
  if (askPerm !== 'ask') fail(`buildTarget should require approval (ask), got '${askPerm}'`);
  const listRuns = tools.find((t) => t.name === 'listRuns');
  const safePerm = listRuns ? (await listRuns.checkPermissions({}, {})).behavior : 'ask';
  if (safePerm !== 'allow') fail(`listRuns should auto-allow, got '${safePerm}'`);
  console.log(`✓ dynamic tools: ${tools.length} loaded; buildTarget=ask, listRuns=allow`);
} catch (err: any) {
  fail(`dynamic tool load failed (${dynUrl}): ${err?.message ?? err}`);
} finally {
  await client.close();
}

console.log('✓ M6 wiring verified');
void wrapMcpTool;
