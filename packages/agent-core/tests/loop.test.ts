import { describe, expect, test } from 'bun:test';
import { queryLoop } from '../src/loop';
import { buildTool } from '../src/tool';
import type { AgentDeps } from '../src/deps';
import type { AgentEvent, LoopResult, NormalizedResponse } from '../src/types';

/** Drive the generator to completion, collecting events + the final LoopResult. */
async function runLoop(params: Parameters<typeof queryLoop>[0]): Promise<{ events: AgentEvent[]; result: LoopResult }> {
  const gen = queryLoop(params);
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

function deps(callModel: AgentDeps['callModel']): AgentDeps {
  return { callModel, uuid: () => 'uuid', now: () => 0, log: () => undefined };
}

const text = (t: string): NormalizedResponse => ({ text: t, toolUses: [], stopReason: 'stop' });
const callTool = (name: string): NormalizedResponse => ({
  text: '',
  toolUses: [{ type: 'tool_use', id: 'tu1', name, input: {} }],
  stopReason: 'tool_use',
});

describe('queryLoop completion guard', () => {
  test('nudges a premature stop, then completes once the model acts', async () => {
    let recorded = false;
    const finish = buildTool({ name: 'finish', description: 'finish', call: async () => { recorded = true; return { ok: true }; } });
    const script = [text('I think I am done.'), callTool('finish')];
    let i = 0;

    const { events, result } = await runLoop({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [finish],
      ctx: {},
      maxTurns: 10,
      deps: deps(async () => script[i++]),
      terminalTools: new Set(['finish']),
      checkCompletion: () => (recorded ? null : 'Record verdicts for the remaining candidates, then finalize_report.'),
    });

    expect(result.reason).toBe('finalized');
    // turn 1 (text-only) was nudged, not stopped
    expect(events.some((e) => e.type === 'done' && e.reason === 'stop')).toBe(false);
    expect(events.some((e) => e.type === 'notice' && e.text.includes('nudging to finish'))).toBe(true);
    // the nudge was threaded back as a user message
    expect(
      result.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('finalize_report')),
    ).toBe(true);
  });

  test('honors a bare stop after maxStopNudges (no infinite loop)', async () => {
    const { events, result } = await runLoop({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      ctx: {},
      maxTurns: 10,
      maxStopNudges: 2,
      deps: deps(async () => text('still talking, no tools')),
      checkCompletion: () => 'please finish', // never satisfied
    });

    const nudges = events.filter((e) => e.type === 'notice' && e.text.includes('nudging to finish'));
    expect(nudges).toHaveLength(2);
    expect(result.reason).toBe('stop');
    expect(result.turns).toBe(3); // 2 nudged turns + 1 final stop
  });

  test('stops normally when checkCompletion is satisfied (returns null)', async () => {
    const { events, result } = await runLoop({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      ctx: {},
      maxTurns: 10,
      deps: deps(async () => text('done')),
      checkCompletion: () => null,
    });

    expect(result.reason).toBe('stop');
    expect(result.turns).toBe(1);
    expect(events.some((e) => e.type === 'notice' && e.text.includes('nudging'))).toBe(false);
  });

  test('a thinking-only response never appends an empty assistant message', async () => {
    // Regression: a turn with only reasoning_content (no text, no tools) used to push
    // content:'' → OpenAI gateways reject "assistant must provide content … or tool_calls".
    const script: NormalizedResponse[] = [
      { text: '', thinking: 'let me think about this', toolUses: [], stopReason: 'stop' },
    ];
    let i = 0;
    const { result } = await runLoop({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      ctx: {},
      maxTurns: 10,
      deps: deps(async () => script[i++]),
    });
    const assistantMsgs = result.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    // content is a non-empty string (carries the thinking), never '' or empty []
    const c = assistantMsgs[0].content;
    expect(typeof c === 'string' ? c.length : (c as unknown[]).length).toBeGreaterThan(0);
  });

  test('without a guard, a bare stop ends immediately (unchanged behavior)', async () => {
    const { result } = await runLoop({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      ctx: {},
      maxTurns: 10,
      deps: deps(async () => text('done')),
    });
    expect(result.reason).toBe('stop');
    expect(result.turns).toBe(1);
  });
});
