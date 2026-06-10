#!/usr/bin/env bun
/**
 * Real-model smoke: drives the agentic loop against the configured local
 * gateway with two tools (a calculator + a terminal "report" tool) to confirm
 * native tool-calling works end-to-end. Host runs rewrite the container URL
 * (host.docker.internal) to localhost.
 *
 *   bun scripts/local-model-smoke.ts
 */

import { z } from 'zod';
import { queryLoop, buildTool, buildCallModel, type AgentEvent, type Tool, type ProviderSettings } from '@mcpvul/agent-core';
import { loadConfig } from '../apps/leak-inspector-tui/src/config';

const cfg = loadConfig({ provider: 'local' });
const baseUrl = cfg.llm.baseUrl.replace('host.docker.internal', 'localhost');
const settings: ProviderSettings = {
  provider: 'local',
  baseUrl,
  apiKey: cfg.llm.apiKey,
  model: cfg.llm.model,
  maxTokens: cfg.llm.maxTokens,
  timeoutMs: cfg.llm.timeoutMs,
  retries: cfg.llm.retries,
};
console.log(`provider=local model=${settings.model} base=${baseUrl}`);

let addArgs: { a: number; b: number } | undefined;
let reported: number | undefined;

const add: Tool = buildTool({
  name: 'add',
  description: 'Add two integers and return their sum.',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input: any) => {
    addArgs = { a: Number(input.a), b: Number(input.b) };
    return { sum: addArgs.a + addArgs.b };
  },
});

const report: Tool = buildTool({
  name: 'report_answer',
  description: 'Report the final numeric answer to the user.',
  inputSchema: z.object({ answer: z.number() }),
  call: async (input: any) => {
    reported = Number(input.answer);
    return { ok: true };
  },
});

const callModel = buildCallModel(settings, () => globalThis.crypto.randomUUID());

const gen = queryLoop({
  systemPrompt:
    'You are a calculator agent. To compute a sum you MUST call the `add` tool. ' +
    'After you have the result, call `report_answer` with the final number. Do not compute in your head.',
  messages: [{ role: 'user', content: 'What is 21 + 21? Use the tools, then report the answer.' }],
  tools: [add, report],
  ctx: {},
  maxTurns: 5,
  deps: { callModel, uuid: () => globalThis.crypto.randomUUID(), now: () => Date.now(), log: () => undefined },
  terminalTools: new Set(['report_answer']),
});

const events: AgentEvent[] = [];
let result;
while (true) {
  const next = await gen.next();
  if (next.done) {
    result = next.value;
    break;
  }
  const ev = next.value;
  events.push(ev);
  if (ev.type === 'tool_use') console.log(`  → tool_use ${ev.name}(${JSON.stringify(ev.input)})`);
  if (ev.type === 'tool_result') console.log(`  ← ${ev.name} ${ev.isError ? 'ERROR ' : ''}${JSON.stringify(ev.output)} (${ev.durationMs}ms)`);
  if (ev.type === 'assistant_text' && ev.text) console.log(`  · ${ev.text.slice(0, 200)}`);
}

console.log(`\nreason=${result.reason} turns=${result.turns} tokens=${result.usage.inputTokens}/${result.usage.outputTokens}`);

const usedAdd = !!addArgs;
const correct = addArgs && addArgs.a + addArgs.b === 42;
if (!usedAdd) {
  console.error('✗ model did not call the add tool');
  process.exit(1);
}
if (!correct) console.warn(`⚠ add called with ${JSON.stringify(addArgs)} (sum != 42, but tool-calling works)`);
console.log(`✓ local-model smoke: native tool-calling works (add called=${usedAdd}, reported=${reported ?? 'n/a'})`);
process.exit(0);
