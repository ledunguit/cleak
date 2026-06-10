#!/usr/bin/env bun
/** Verifies the loop injects user steering messages between turns (getSteering). */

import { queryLoop, buildTool, type CallModel, type Tool } from '@mcpvul/agent-core';

let turn = 0;
const fakeModel: CallModel = async () => {
  turn++;
  if (turn >= 2) return { text: 'done', toolUses: [], stopReason: 'stop' };
  return { text: 'working', toolUses: [{ type: 'tool_use', id: 'a', name: 'noop', input: {} }], stopReason: 'tool_use' };
};
const noop: Tool = buildTool({
  name: 'noop',
  description: 'noop',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async () => ({ ok: true }),
});

let given = false;
const gen = queryLoop({
  systemPrompt: 't',
  messages: [{ role: 'user', content: 'start' }],
  tools: [noop],
  ctx: {},
  maxTurns: 5,
  deps: { callModel: fakeModel, uuid: () => 'i', now: () => 0, log: () => undefined },
  getSteering: () => {
    if (!given) {
      given = true;
      return ['please focus on the realloc path'];
    }
    return [];
  },
});

let result;
while (true) {
  const next = await gen.next();
  if (next.done) {
    result = next.value;
    break;
  }
}

const injected = result.messages.some(
  (m) => m.role === 'user' && (typeof m.content === 'string' ? m.content : '').includes('realloc path'),
);
if (!injected) {
  console.error('✗ steering message was NOT injected into the conversation');
  console.error(result.messages.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[blocks]'}`).join('\n'));
  process.exit(1);
}
console.log('✓ steering: user message injected mid-run and seen by the model');
