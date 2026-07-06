import { describe, expect, test } from 'bun:test';
import { createOpenAiStreamAssembler, createAnthropicStreamAssembler } from '../../src/providers/normalize';

const uuid = () => 'generated-id';

/** Build an OpenAI streaming chunk `data:` payload from a single delta. */
const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ choices: [{ delta, ...extra }] });
const toolDelta = (index: number, fn: Record<string, unknown>, id?: string) =>
  ({ tool_calls: [{ index, ...(id ? { id } : {}), function: fn }] });

describe('createOpenAiStreamAssembler', () => {
  test('reconstructs text + multi-fragment tool call + usage', () => {
    const a = createOpenAiStreamAssembler(uuid);
    a.push(chunk({ content: 'Hel' }));
    a.push(chunk({ content: 'lo' }));
    a.push(chunk({ reasoning_content: 'thinking…' }));
    // tool_call arguments split across two fragments (mid-JSON).
    a.push(chunk(toolDelta(0, { name: 'read_file', arguments: '{"path":' }, 'call_1')));
    a.push(chunk(toolDelta(0, { arguments: '"a.c"}' })));
    a.push(chunk({}, { finish_reason: 'tool_calls' }));
    a.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 42 } }));

    const r = a.finish();
    expect(r.text).toBe('Hello');
    expect(r.thinking).toBe('thinking…');
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses[0].id).toBe('call_1');
    expect(r.toolUses[0].name).toBe('read_file');
    expect(r.toolUses[0].input).toEqual({ path: 'a.c' });
    // thinkingTokens estimated from the streamed reasoning text ('thinking…').
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 42, thinkingTokens: 3 });
    expect(r.stopReason).toBe('tool_use');
  });

  test('prefers provider-reported reasoning_tokens over the estimate', () => {
    const a = createOpenAiStreamAssembler(uuid);
    a.push(chunk({ reasoning_content: 'x' }));
    a.push(JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 55 } },
    }));
    expect(a.finish().usage).toEqual({ inputTokens: 100, outputTokens: 80, thinkingTokens: 55 });
  });

  test('two parallel tool calls keyed by index', () => {
    const a = createOpenAiStreamAssembler(uuid);
    a.push(chunk(toolDelta(0, { name: 'f0', arguments: '{}' }, 'c0')));
    a.push(chunk(toolDelta(1, { name: 'f1', arguments: '{}' }, 'c1')));
    const r = a.finish();
    expect(r.toolUses.map((t) => t.name)).toEqual(['f0', 'f1']);
  });

  test('plain text answer → stop', () => {
    const a = createOpenAiStreamAssembler(uuid);
    a.push(chunk({ content: 'done' }, { finish_reason: 'stop' }));
    const r = a.finish();
    expect(r.stopReason).toBe('stop');
    expect(r.toolUses).toHaveLength(0);
  });

  test('ignores unparseable payloads', () => {
    const a = createOpenAiStreamAssembler(uuid);
    a.push('not json');
    a.push(chunk({ content: 'x' }));
    expect(a.finish().text).toBe('x');
  });
});

describe('createAnthropicStreamAssembler', () => {
  test('reconstructs text, thinking, tool_use, and usage from the event stream', () => {
    const a = createAnthropicStreamAssembler(uuid);
    a.push(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 900 } } }));
    a.push(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
    a.push(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }));
    a.push(JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }));
    a.push(JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } }));
    a.push(JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_9', name: 'record_verdict' } }));
    a.push(JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"v":' } }));
    a.push(JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"leak"}' } }));
    a.push(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }));

    const r = a.finish();
    expect(r.text).toBe('Answer');
    expect(r.thinking).toBe('hmm');
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses[0].id).toBe('tu_9');
    expect(r.toolUses[0].name).toBe('record_verdict');
    expect(r.toolUses[0].input).toEqual({ v: 'leak' });
    // thinkingTokens estimated from the 'hmm' thinking delta (Anthropic folds it into output).
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 30, thinkingTokens: 1 });
    expect(r.stopReason).toBe('tool_use');
  });
});
