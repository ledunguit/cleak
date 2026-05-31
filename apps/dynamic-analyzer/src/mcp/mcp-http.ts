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

  app.post('/mcp', async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
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
