/**
 * Minimal MCP client over Streamable HTTP. Connects to one analyzer endpoint,
 * discovers its tools via `tools/list`, and calls them — preferring
 * `structuredContent`, falling back to parsing the text content block.
 * Mirrors the connection style of the control-plane's MCP client manager.
 *
 * Transport ops retry on TRANSIENT faults (a reset / closed keep-alive socket —
 * common when many scans open connections at once, e.g. an eval at high
 * concurrency). A dead transport is dropped and reconnected before the next
 * attempt. Aborts and tool-level errors are never retried.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface RemoteTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool input (passed through verbatim to the model). */
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpClientOptions {
  /** Max retry attempts on a TRANSIENT transport error. 0 disables retry. Defaults to env MCP_MAX_RETRIES or 3. */
  maxRetries?: number;
  /** Notified before each backoff so a caller can surface "retrying…". */
  onRetry?: (info: { action: string; attempt: number; delayMs: number; reason: string }) => void;
}

/**
 * Transport-level faults worth retrying — a dead keep-alive socket, a reset, a
 * refused/cut connection. Deliberately EXCLUDES tool-level errors and aborts.
 * "socket connection was closed unexpectedly" is the exact Bun/undici message
 * seen when a server reaps an idle keep-alive socket mid-request.
 */
const TRANSIENT_ERROR_RE =
  /ECONNRESET|socket connection was closed unexpectedly|socket hang ?up|EPIPE|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network error|\bterminated\b|stream (?:closed|removed)|other side closed|premature close/i;

/** Flatten an error (message + code + nested cause) into one searchable string. */
function messageOf(err: unknown): string {
  const e = err as any;
  if (!e) return '';
  const parts = [e.message, e.code, e.cause?.message, e.cause?.code].filter((x): x is string => typeof x === 'string');
  return parts.length ? parts.join(' | ') : String(err);
}

export function isTransientError(err: unknown): boolean {
  const e = err as any;
  if (e?.name === 'AbortError') return false; // caller-initiated cancel — not transient
  const msg = messageOf(err);
  if (msg.startsWith('MCP tool ')) return false; // a tool's own failure, not the transport
  return TRANSIENT_ERROR_RE.test(msg);
}

/** Jittered exponential backoff (mirrors agent-core providers/transport.ts). */
function backoffDelay(attempt: number): number {
  const base = Math.min(250 * 2 ** attempt, 4000);
  return Math.round(base + Math.random() * base * 0.3);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `op` through a bounded jittered backoff, retrying ONLY transient transport
 * faults. Aborts and non-transport errors propagate immediately. `beforeRetry`
 * runs between attempts (the MCP client uses it to drop+reconnect a dead socket).
 * Exported so the retry policy is unit-testable independently of the SDK transport.
 */
export async function retryTransient<T>(
  op: () => Promise<T>,
  opts: {
    maxRetries: number;
    signal?: AbortSignal;
    beforeRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void | Promise<void>;
    backoffMs?: (attempt: number) => number;
  },
): Promise<T> {
  const backoff = opts.backoffMs ?? backoffDelay;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted || attempt >= opts.maxRetries || !isTransientError(err)) throw err;
      const delayMs = backoff(attempt);
      await opts.beforeRetry?.({ attempt: attempt + 1, delayMs, reason: messageOf(err) });
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

export class McpClient {
  private client?: Client;
  private connecting?: Promise<void>;
  private readonly maxRetries: number;
  private readonly onRetry?: McpClientOptions['onRetry'];

  constructor(
    private readonly url: string,
    private readonly label: string,
    opts: McpClientOptions = {},
  ) {
    const envRetries = Number(process.env.MCP_MAX_RETRIES);
    this.maxRetries = opts.maxRetries ?? (Number.isFinite(envRetries) ? envRetries : 3);
    this.onRetry = opts.onRetry;
  }

  get endpoint(): string {
    return this.url;
  }

  /**
   * Run a transport operation through a bounded jittered backoff. A TRANSIENT
   * failure drops the (possibly dead) client so the next attempt reconnects
   * fresh. Aborts and non-transport errors (tool failures) propagate immediately.
   */
  private withRetry<T>(op: () => Promise<T>, action: string, signal?: AbortSignal): Promise<T> {
    return retryTransient(op, {
      maxRetries: this.maxRetries,
      signal,
      beforeRetry: async (info) => {
        await this.close(); // transport may be dead — force a clean reconnect
        this.onRetry?.({ action, ...info });
      },
    });
  }

  /** Open the transport once; memoized. Resets the memo on failure so a later attempt can reconnect. */
  private connectOnce(): Promise<void> {
    if (this.client) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: `leak-tui-${this.label}`, version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
        this.client = client;
      })().catch((err) => {
        this.connecting = undefined; // never cache a rejected connect — it would poison every later call
        throw err;
      });
    }
    return this.connecting;
  }

  async connect(): Promise<void> {
    await this.withRetry(() => this.connectOnce(), 'connect');
  }

  async listTools(): Promise<RemoteTool[]> {
    return this.withRetry(async () => {
      await this.connectOnce();
      const res = await this.client!.listTools();
      return ((res.tools ?? []) as unknown[]).map((t) => t as RemoteTool);
    }, 'listTools');
  }

  /** Call a tool; returns parsed structuredContent (preferred) or parsed text content. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> {
    return this.withRetry(
      async () => {
        await this.connectOnce();
        const reqOpts: Record<string, unknown> = { timeout: opts?.timeoutMs ?? 60000 };
        if (opts?.signal) reqOpts.signal = opts.signal;
        const res: any = await this.client!.callTool({ name, arguments: args ?? {} }, undefined, reqOpts);
        if (res?.isError) {
          const msg = Array.isArray(res.content)
            ? res.content
                .map((c: any) => c?.text)
                .filter(Boolean)
                .join('; ')
            : 'unknown error';
          throw new Error(`MCP tool ${name} failed: ${msg}`);
        }
        if (res?.structuredContent !== undefined && res.structuredContent !== null) {
          return res.structuredContent;
        }
        const text = Array.isArray(res?.content) ? res.content.find((c: any) => c?.type === 'text')?.text : undefined;
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch {
          return { text };
        }
      },
      `callTool ${name}`,
      opts?.signal,
    );
  }

  async ping(): Promise<boolean> {
    try {
      await this.listTools();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.connecting = undefined;
  }
}
