import { afterAll, describe, expect, test } from 'bun:test';
import { streamWithRetry } from '../../src/providers/transport';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

interface StubBehavior {
  /** Emit these SSE payloads with `gapMs` between each; -1 gap = stall forever. */
  chunks?: Array<{ data: string; gapMs: number }>;
  /** Return a non-SSE JSON body instead of a stream. */
  json?: unknown;
  /** Status codes to return on the first N calls before succeeding. */
  failStatuses?: number[];
}

let calls = 0;
let behavior: StubBehavior = {};

const server = Bun.serve({
  port: 0,
  async fetch() {
    const attempt = calls++;
    if (behavior.failStatuses && attempt < behavior.failStatuses.length) {
      return new Response('busy', { status: behavior.failStatuses[attempt] });
    }
    if (behavior.json !== undefined) {
      return new Response(JSON.stringify(behavior.json), { headers: { 'content-type': 'application/json' } });
    }
    const chunks = behavior.chunks ?? [];
    const stream = new ReadableStream({
      async pull(ctrl) {
        for (const c of chunks) {
          if (c.gapMs < 0) {
            await sleep(10_000); // stall — client idle timeout should fire first
          } else if (c.gapMs > 0) {
            await sleep(c.gapMs);
          }
          ctrl.enqueue(enc.encode(`data: ${c.data}\n\n`));
        }
        ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
});

const url = `http://localhost:${server.port}/`;

function reset(b: StubBehavior) {
  calls = 0;
  behavior = b;
}

afterAll(() => server.stop(true));

const base = { connectTimeoutMs: 1000, idleTimeoutMs: 150, retries: 2, onJsonFallback: () => {} };

describe('streamWithRetry idle timeout', () => {
  test('survives gaps shorter than the idle timeout', async () => {
    reset({ chunks: [{ data: '{"n":1}', gapMs: 80 }, { data: '{"n":2}', gapMs: 80 }, { data: '{"n":3}', gapMs: 80 }] });
    const seen: string[] = [];
    await streamWithRetry(url, { method: 'POST' }, { ...base, onData: (p) => seen.push(p) });
    expect(seen).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  test('aborts when the stream stalls past the idle timeout', async () => {
    reset({ chunks: [{ data: '{"n":1}', gapMs: 0 }, { data: '{"n":2}', gapMs: -1 }] });
    const seen: string[] = [];
    let err: unknown;
    await streamWithRetry(url, { method: 'POST' }, { ...base, retries: 0, onData: (p) => seen.push(p) }).catch(
      (e) => (err = e),
    );
    expect(seen).toEqual(['{"n":1}']); // first chunk delivered, then it hung
    expect(String(err)).toContain('stalled');
  });

  test('does NOT re-POST after a mid-stream stall (no double delivery)', async () => {
    reset({ chunks: [{ data: '{"n":1}', gapMs: 0 }, { data: '{"n":2}', gapMs: -1 }] });
    await streamWithRetry(url, { method: 'POST' }, { ...base, retries: 2, onData: () => {} }).catch(() => {});
    expect(calls).toBe(1); // delivered once → no retry despite retries:2
  });

  test('retries a pre-stream 503 then succeeds', async () => {
    reset({ failStatuses: [503], chunks: [{ data: '{"ok":true}', gapMs: 0 }] });
    const seen: string[] = [];
    await streamWithRetry(url, { method: 'POST' }, { ...base, onData: (p) => seen.push(p) });
    expect(calls).toBe(2);
    expect(seen).toEqual(['{"ok":true}']);
  });

  test('falls back to JSON when the gateway ignores stream:true', async () => {
    reset({ json: { choices: [{ message: { content: 'hi' } }] } });
    let raw: string | undefined;
    await streamWithRetry(url, { method: 'POST' }, { ...base, onData: () => {}, onJsonFallback: (r) => (raw = r) });
    expect(raw).toContain('"content":"hi"');
  });

  test('fires onFirstChunk exactly once, before onData', async () => {
    reset({ chunks: [{ data: '{"n":1}', gapMs: 0 }, { data: '{"n":2}', gapMs: 20 }, { data: '{"n":3}', gapMs: 20 }] });
    let firstChunks = 0;
    let dataAtFirstChunk = -1;
    const seen: string[] = [];
    await streamWithRetry(url, { method: 'POST' }, {
      ...base,
      onData: (p) => seen.push(p),
      onFirstChunk: () => {
        firstChunks++;
        dataAtFirstChunk = seen.length; // onData for this payload hasn't run yet
      },
    });
    expect(firstChunks).toBe(1);
    expect(dataAtFirstChunk).toBe(0);
    expect(seen).toHaveLength(3);
  });
});
