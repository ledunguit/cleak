/**
 * Integration: drive the real callOpenAiChat (the exact path used against the
 * local OpenAI-compatible gateway) through a streaming SSE stub — no gateway required. Proves
 * the request opts into streaming and the SSE deltas fold into a NormalizedResponse.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { callOpenAiChat } from '../../src/providers/openaiChat';
import type { ProviderSettings } from '../../src/providers/settings';
import type { CallModelRequest } from '../../src/deps';

let lastBody: any;
let mode: 'stream' | 'json' = 'stream';

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  if (mode === 'json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'plain' }, finish_reason: 'stop' }] }));
    return;
  }
  const lines = [
    { choices: [{ delta: { content: 'Look' } }] },
    { choices: [{ delta: { content: 'ing' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":"x.c"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 500, completion_tokens: 12 } },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const l of lines) res.write(`data: ${JSON.stringify(l)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});
server.listen(0);
const serverAddress = server.address();
const serverPort = typeof serverAddress === 'object' && serverAddress ? serverAddress.port : 0;

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const settings: ProviderSettings = {
  provider: 'local',
  baseUrl: `http://localhost:${serverPort}`,
  apiKey: '',
  model: 'deepseek-v4-flash-0731',
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

describe('callOpenAiChat — response_format (jsonMode)', () => {
  test('jsonMode + no tools → requests the provider JSON-object response mode', async () => {
    mode = 'json';
    await callOpenAiChat({ ...settings, jsonMode: true }, req, () => 'uuid');
    expect(lastBody.response_format).toEqual({ type: 'json_object' });
    expect(lastBody.tools).toBeUndefined();
  });

  test('jsonMode + tools present → tools win, no response_format (never touches agentic loops)', async () => {
    mode = 'json';
    const toolReq: CallModelRequest = {
      ...req,
      tools: [
        {
          name: 'read_file',
          description: 'read a file',
          inputSchema: undefined,
          inputJSONSchema: { type: 'object', properties: {} },
          isReadOnly: () => true,
          isConcurrencySafe: () => true,
          call: async () => ({}),
        } as any,
      ],
    };
    await callOpenAiChat({ ...settings, jsonMode: true }, toolReq, () => 'uuid');
    expect(lastBody.tools).toBeDefined();
    expect(lastBody.response_format).toBeUndefined();
  });

  test('jsonMode false/undefined → no response_format sent (unchanged default behavior)', async () => {
    mode = 'json';
    await callOpenAiChat(settings, req, () => 'uuid');
    expect(lastBody.response_format).toBeUndefined();
  });
});
