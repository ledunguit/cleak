import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Serve MCP over Streamable HTTP in stateless JSON mode. Cross-container MCP
 * requires HTTP transport — stdio cannot span Docker containers. Per the MCP
 * SDK, stateless mode creates a fresh server + transport per request so
 * concurrent requests cannot collide on JSON-RPC ids.
 */
export async function startMcpHttp(createServer: () => McpServer, port: number, label: string): Promise<void> {
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

  app.post('/mcp', async (req, res) => {
    if (inFlight >= maxConcurrent) {
      res.status(503).set('Retry-After', '1').json({
        jsonrpc: '2.0',
        error: { code: -32000, message: `${label} MCP is at capacity (${maxConcurrent} concurrent requests) — retry shortly` },
        id: null,
      });
      return;
    }
    inFlight++;
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      inFlight--;
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(err) }, id: null });
      }
    }
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', transport: 'mcp', label }));

  await new Promise<void>((resolveListen) => app.listen(port, () => resolveListen()));
  console.log(`${label} MCP (Streamable HTTP) listening on :${port}/mcp`);
}
