/**
 * Integration: drive the real callOpenAiChat (the exact path used against the
 * local mimo gateway) through a streaming SSE stub — no gateway required. Proves
 * the request opts into streaming and the SSE deltas fold into a NormalizedResponse.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { callOpenAiChat } from './openaiChat';
import type { ProviderSettings } from './settings';
import type { CallModelRequest } from '../deps';

const enc = new TextEncoder();
let lastBody: any;
let mode: 'stream' | 'json' = 'stream';

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    lastBody = await req.json();
    if (mode === 'json') {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'plain' }, finish_reason: 'stop' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const lines = [
      { choices: [{ delta: { content: 'Look' } }] },
      { choices: [{ delta: { content: 'ing' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":"x.c"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 500, completion_tokens: 12 } },
    ];
    const stream = new ReadableStream({
      start(ctrl) {
        for (const l of lines) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(l)}\n\n`));
        ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
});

afterAll(() => server.stop(true));

const settings: ProviderSettings = {
  provider: 'local',
  baseUrl: `http://localhost:${server.port}`,
  apiKey: '',
  model: 'mimo/mimo-v2.5-pro',
  maxTokens: 256,
  timeoutMs: 75_000,
  idleTimeoutMs: 1_000,
  connectTimeoutMs: 1_000,
  retries: 0,
};

const req: CallModelRequest = { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] };

describe('callOpenAiChat (streaming)', () => {
  test('opts into streaming and assembles text + tool call + usage', async () => {
    mode = 'stream';
    const r = await callOpenAiChat(settings, req, () => 'uuid');
    expect(lastBody.stream).toBe(true);
    expect(lastBody.stream_options).toEqual({ include_usage: true });
    expect(r.text).toBe('Looking');
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses[0].name).toBe('read_file');
    expect(r.toolUses[0].input).toEqual({ path: 'x.c' });
    expect(r.usage).toEqual({ inputTokens: 500, outputTokens: 12, thinkingTokens: 0 });
  });

  test('falls back cleanly if the gateway returns a non-stream JSON body', async () => {
    mode = 'json';
    const r = await callOpenAiChat(settings, req, () => 'uuid');
    expect(r.text).toBe('plain');
    expect(r.stopReason).toBe('stop');
  });
});
