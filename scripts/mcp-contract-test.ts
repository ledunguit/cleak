#!/usr/bin/env bun
/**
 * MCP contract test — asserts both analyzer servers expose their expected tool
 * catalogs over Streamable HTTP. Run after starting the analyzers in MCP mode:
 *
 *   (cd apps/static-analyzer  && TRANSPORT_MODE=mcp MCP_HTTP_PORT=50071 bun run dev)
 *   (cd apps/dynamic-analyzer && TRANSPORT_MODE=mcp MCP_HTTP_PORT=50072 bun run dev)
 *   STATIC_ANALYZER_MCP_URL=http://127.0.0.1:50071/mcp \
 *   DYNAMIC_ANALYZER_MCP_URL=http://127.0.0.1:50072/mcp bun scripts/mcp-contract-test.ts
 */

import { McpClient } from '@cleak/agent-core';
import { STATIC_TOOL_NAMES, DYNAMIC_TOOL_NAMES } from '../apps/leak-inspector-tui/src/domain/mcpToolPlan';

const STATIC_URL = process.env.STATIC_ANALYZER_MCP_URL ?? 'http://127.0.0.1:50071/mcp';
const DYNAMIC_URL = process.env.DYNAMIC_ANALYZER_MCP_URL ?? 'http://127.0.0.1:50072/mcp';

async function checkServer(label: string, url: string, expected: readonly string[]): Promise<boolean> {
  const client = new McpClient(url, label);
  try {
    const tools = await client.listTools();
    const got = new Set(tools.map((t) => t.name));
    const missing = expected.filter((n) => !got.has(n));
    const extra = [...got].filter((n) => !expected.includes(n));
    process.stdout.write(`\n${label} (${url}): ${tools.length} tools\n`);
    for (const t of tools) {
      const hasSchema = t.inputSchema && typeof t.inputSchema === 'object' ? '✓schema' : '✗schema';
      process.stdout.write(`  • ${t.name.padEnd(22)} ${hasSchema}\n`);
    }
    if (missing.length) process.stdout.write(`  ✗ MISSING: ${missing.join(', ')}\n`);
    if (extra.length) process.stdout.write(`  ⚠ extra (not in plan): ${extra.join(', ')}\n`);
    return missing.length === 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\n${label} (${url}): ✗ ${msg}\n`);
    return false;
  } finally {
    await client.close();
  }
}

const okStatic = await checkServer('static-analyzer', STATIC_URL, STATIC_TOOL_NAMES);
const okDynamic = await checkServer('dynamic-analyzer', DYNAMIC_URL, DYNAMIC_TOOL_NAMES);

if (okStatic && okDynamic) {
  process.stdout.write('\n✓ MCP contract OK — all expected tools present on both servers.\n');
  process.exit(0);
}
process.stdout.write('\n✗ MCP contract FAILED.\n');
process.exit(1);
