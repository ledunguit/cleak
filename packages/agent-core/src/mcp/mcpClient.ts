/**
 * Minimal MCP client over Streamable HTTP. Connects to one analyzer endpoint,
 * discovers its tools via `tools/list`, and calls them — preferring
 * `structuredContent`, falling back to parsing the text content block.
 * Mirrors the connection style of the control-plane's MCP client manager.
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

export class McpClient {
  private client?: Client;
  private connecting?: Promise<void>;

  constructor(
    private readonly url: string,
    private readonly label: string,
  ) {}

  get endpoint(): string {
    return this.url;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({
          name: `leak-tui-${this.label}`,
          version: "1.0.0",
        });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(this.url)),
        );
        this.client = client;
      })();
    }
    await this.connecting;
  }

  async listTools(): Promise<RemoteTool[]> {
    await this.connect();
    const res = await this.client!.listTools();
    return ((res.tools ?? []) as unknown[]).map((t) => t as RemoteTool);
  }

  /** Call a tool; returns parsed structuredContent (preferred) or parsed text content. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> {
    await this.connect();
    const reqOpts: Record<string, unknown> = { timeout: opts?.timeoutMs ?? 60000 };
    if (opts?.signal) reqOpts.signal = opts.signal;
    const res: any = await this.client!.callTool({ name, arguments: args ?? {} }, undefined, reqOpts);
    if (res?.isError) {
      const msg = Array.isArray(res.content)
        ? res.content
            .map((c: any) => c?.text)
            .filter(Boolean)
            .join("; ")
        : "unknown error";
      throw new Error(`MCP tool ${name} failed: ${msg}`);
    }
    if (
      res?.structuredContent !== undefined &&
      res.structuredContent !== null
    ) {
      return res.structuredContent;
    }
    const text = Array.isArray(res?.content)
      ? res.content.find((c: any) => c?.type === "text")?.text
      : undefined;
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
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
