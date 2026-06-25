#!/usr/bin/env bun
/**
 * Loop smoke test with a scripted (fake) callModel — no network. Verifies the
 * turn loop dispatches tools, threads tool_result blocks back, runs the
 * concurrent vs serial partition, and terminates on a terminal tool.
 */

import {
  queryLoop,
  buildTool,
  toOpenAiMessages,
  type AgentEvent,
  type AgentDeps,
  type CallModel,
  type NormalizedResponse,
  type Tool,
} from '@cleak/agent-core';

let seq = 0;
const uuid = () => `id-${++seq}`;
const deps: AgentDeps = { callModel: undefined as any, uuid, now: () => 0, log: () => undefined };

const calls: string[] = [];

const echo: Tool = buildTool({
  name: 'echo',
  description: 'echo text',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input: any) => {
    calls.push(`echo:${input.text}`);
    return { echoed: input.text };
  },
});

const finalize: Tool = buildTool({
  name: 'finalize_report',
  description: 'finish',
  call: async () => {
    calls.push('finalize');
    return { ok: true };
  },
});

// Scripted model: turn 1 calls echo twice (concurrent), turn 2 finalizes.
const script: NormalizedResponse[] = [
  {
    text: 'echoing',
    toolUses: [
      { type: 'tool_use', id: 'a', name: 'echo', input: { text: 'one' } },
      { type: 'tool_use', id: 'b', name: 'echo', input: { text: 'two' } },
    ],
    stopReason: 'tool_use',
  },
  {
    text: 'done',
    toolUses: [{ type: 'tool_use', id: 'c', name: 'finalize_report', input: {} }],
    stopReason: 'tool_use',
  },
];
let turn = 0;
const fakeModel: CallModel = async () => script[Math.min(turn++, script.length - 1)];

const events: AgentEvent[] = [];
const gen = queryLoop({
  systemPrompt: 'test',
  messages: [{ role: 'user', content: 'go' }],
  tools: [echo, finalize],
  ctx: {},
  maxTurns: 5,
  deps: { ...deps, callModel: fakeModel },
  terminalTools: new Set(['finalize_report']),
});

let result;
while (true) {
  const next = await gen.next();
  if (next.done) {
    result = next.value;
    break;
  }
  events.push(next.value);
}

// ── Assertions ──
const fail = (m: string) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

const toolResults = events.filter((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>[];
if (toolResults.length !== 3) fail(`expected 3 tool_result events, got ${toolResults.length}`);
if (toolResults.some((e) => e.isError)) fail('a tool_result was an error');
if (result.reason !== 'finalized') fail(`expected reason 'finalized', got '${result.reason}'`);
if (!calls.includes('echo:one') || !calls.includes('echo:two') || !calls.includes('finalize'))
  fail(`tools did not all run: ${calls.join(', ')}`);

// Messages threaded correctly: user, assistant(2 tool_use), user(2 tool_result), assistant(finalize), user(1 tool_result)
const roles = result.messages.map((m) => m.role).join(',');
if (roles !== 'user,assistant,user,assistant,user') fail(`unexpected message roles: ${roles}`);

// OpenAI normalization expands tool_result blocks into `tool` role messages.
const oai = toOpenAiMessages('sys', result.messages) as any[];
const toolMsgs = oai.filter((m) => m.role === 'tool');
if (toolMsgs.length !== 3) fail(`expected 3 openai tool messages, got ${toolMsgs.length}`);
const assistantWithCalls = oai.filter((m) => m.role === 'assistant' && m.tool_calls);
if (assistantWithCalls.length !== 2) fail(`expected 2 assistant tool_calls messages, got ${assistantWithCalls.length}`);

console.log('✓ loop smoke: 3 tool results, finalized, messages + openai normalization correct');
console.log(`  events=${events.length} turns=${result.turns} calls=[${calls.join(', ')}]`);
process.exit(0);
