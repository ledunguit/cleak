import { randomUUID } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runWithContext } from './request-context';
import { ServerEventName } from './server-events';

/** Structural subset of pino's `Logger` this file actually calls — kept minimal
 * and duck-typed so `@cleak/common` never needs a hard dependency on pino
 * itself; the concrete logger is built by `@cleak/observability` and injected
 * by each app's `main.ts`. */
export interface McpHttpLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** Short audit label for a JSON-RPC body: `toolName(argPreview)` or the bare method. */
function describeMcpCall(body: unknown): string {
  const b = body as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | undefined;
  if (!b?.method) return 'unknown';
  if (b.method !== 'tools/call' || !b.params?.name) return b.method;
  const args = b.params.arguments ?? {};
  // Keep the preview short and non-sensitive: key names + short scalar values only,
  // never full file contents (candidateScan/functionSummary send source inline).
  const preview = Object.entries(args)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}=${v.length > 60 ? v.slice(0, 60) + '…' : v}`;
      if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
      if (Array.isArray(v)) return `${k}=[${v.length}]`;
      return `${k}=…`;
    })
    .join(', ');
  return `${b.params.name}(${preview})`;
}

/**
 * Serve MCP over Streamable HTTP in stateless JSON mode. Cross-container MCP
 * requires HTTP transport — stdio cannot span Docker containers. Per the MCP
 * SDK, stateless mode creates a fresh server + transport per request so
 * concurrent requests cannot collide on JSON-RPC ids.
 *
 * This is the ONE place a request's `requestId`/`correlationId` context is
 * established (via `runWithContext`, `node:async_hooks` `AsyncLocalStorage`
 * under the hood) — everything downstream (`instrumentTool`, and every
 * service-level log call inside a tool handler) inherits it automatically
 * through the logger's `mixin` hook, with no parameter threading past this
 * one wrap point. `correlationId` is read from the `x-scan-id` header the MCP
 * client optionally attaches per scan — a plain HTTP header, invisible to the
 * JSON-RPC payload / tool schemas.
 */
export async function startMcpHttp(createServer: () => McpServer, port: number, label: string, logger: McpHttpLogger): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Every request is accepted and dispatched immediately by default — the ONLY
  // backpressure downstream is deep inside each service (static-analyzer's
  // Piscina pool, dynamic-analyzer's run semaphore), both with unbounded/large
  // internal queues. Under real-project load (hundreds of candidates firing
  // concurrent functionSummary/pathConstraints calls) that means requests pile
  // up silently until the CLIENT's own timeout fires, with no signal from the
  // server that it's overloaded. A bounded in-flight counter here turns
  // "silent timeout" into an immediate, retryable 503 — the client's MCP
  // transport retry (`isTransientError`) already treats a 503 as transient.
  // Default is deliberately generous (well above today's real concurrency
  // ceiling: discoveryConcurrency(4) x staticConcurrency(3) x case-
  // concurrency(3) ≈ 36) so this only fires on genuine overload, never on
  // ordinary load. Env-tunable per deployment.
  const maxConcurrent = Math.max(1, Number(process.env.MCP_MAX_CONCURRENT_REQUESTS) || 200);
  let inFlight = 0;

  app.post('/mcp', (req, res) => {
    const requestId = randomUUID();
    const correlationId = req.header('x-scan-id') || undefined;
    return runWithContext({ requestId, correlationId, label: label as 'static-analyzer' | 'dynamic-analyzer' }, async () => {
      const startedAt = Date.now();
      const call = describeMcpCall(req.body);
      if (inFlight >= maxConcurrent) {
        logger.warn({ event: ServerEventName.MCP_REQUEST_REJECTED, call, maxConcurrent }, `request rejected (at capacity): ${call}`);
        res.status(503).set('Retry-After', '1').json({
          jsonrpc: '2.0',
          error: { code: -32000, message: `${label} MCP is at capacity (${maxConcurrent} concurrent requests) — retry shortly` },
          id: null,
        });
        return;
      }
      inFlight++;
      logger.info({ event: ServerEventName.MCP_REQUEST_RECEIVED, call }, `request received: ${call}`);
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      let logged = false;
      const logCompletion = () => {
        if (logged) return;
        logged = true;
        const durationMs = Date.now() - startedAt;
        const outcome = res.headersSent ? (res.statusCode < 400 ? 'ok' : `http_${res.statusCode}`) : 'closed_no_response';
        logger.info({ event: ServerEventName.MCP_REQUEST_COMPLETED, call, durationMs, outcome }, `request completed: ${call}`);
      };
      res.on('close', () => {
        inFlight--;
        logCompletion();
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error(
          { event: ServerEventName.MCP_REQUEST_ERRORED, call, durationMs: Date.now() - startedAt, err: String(err) },
          `request errored: ${call}`,
        );
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(err) }, id: null });
        }
      }
    });
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', transport: 'mcp', label }));

  await new Promise<void>((resolveListen) => app.listen(port, () => resolveListen()));
  logger.info({ event: 'startup', port }, `${label} MCP (Streamable HTTP) listening on :${port}/mcp`);
}
