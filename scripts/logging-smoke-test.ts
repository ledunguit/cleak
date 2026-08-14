#!/usr/bin/env -S tsx
/**
 * Logging regression guard for `packages/observability`. Spawns BOTH analyzers
 * itself (on isolated ports, so it never collides with an already-running
 * `docker compose` stack) — unlike `scripts/mcp-contract-test.ts`, which only
 * checks tool catalogs against servers someone else started — because this test
 * needs to capture the servers' own stdout to assert on the JSON log lines they
 * emit.
 *
 * Asserts the two things that were silently broken before this session's work:
 *  1. A successful tool call leaves a trace at all (`mcp_tool_started` +
 *     `mcp_tool_finished`, paired by `requestId`) — not just failures.
 *  2. A genuine failure (a bad `buildTarget`) produces a correlatable
 *     `build_failed` + `mcp_tool_failed` pair, not a raw uncorrelated dump.
 * Also checks `x-scan-id` → `correlationId` propagation end-to-end.
 *
 * Usage: pnpm exec tsx scripts/logging-smoke-test.ts
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpClient } from '@cleak/agent-core';

const STATIC_PORT = 50161;
const DYNAMIC_PORT = 50162;
const CORRELATION_ID = 'smoke-test-scan';

interface SpawnedServer {
  proc: ChildProcessWithoutNullStreams;
  lines: () => string[];
}

function spawnServer(app: 'static-analyzer' | 'dynamic-analyzer', port: number): SpawnedServer {
  const lines: string[] = [];
  const proc = spawn('pnpm', ['exec', 'tsx', `apps/${app}/src/main.ts`], {
    cwd: process.cwd(),
    env: { ...process.env, MCP_HTTP_PORT: String(port), LOG_FORMAT: 'json', LOG_LEVEL: 'info' },
  });
  const onData = (buf: Buffer) => {
    for (const line of buf.toString('utf-8').split('\n')) if (line.trim()) lines.push(line);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  return { proc, lines: () => lines };
}

async function waitForHealth(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`server at ${url} did not become healthy within ${timeoutMs}ms`);
}

/** Parse whatever JSON log lines are in the captured output — non-JSON lines
 * (transport startup banners, stack traces on hard crash) are ignored, not fatal. */
function parseJsonLines(lines: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {
      /* not a JSON log line */
    }
  }
  return out;
}

function assertPaired(events: Record<string, unknown>[], startEvent: string, endEvents: string[], label: string): void {
  const starts = events.filter((e) => e.event === startEvent);
  if (starts.length === 0) throw new Error(`${label}: no "${startEvent}" event captured — logging went silent`);
  for (const s of starts) {
    const rid = s.requestId;
    const paired = events.find((e) => e.requestId === rid && endEvents.includes(e.event as string));
    if (!paired) throw new Error(`${label}: "${startEvent}" (requestId=${rid}) has no matching ${endEvents.join('|')} — unpaired lifecycle`);
  }
}

async function main(): Promise<void> {
  console.log('Spawning static-analyzer + dynamic-analyzer on isolated ports for a logging smoke test…');
  const staticSrv = spawnServer('static-analyzer', STATIC_PORT);
  const dynamicSrv = spawnServer('dynamic-analyzer', DYNAMIC_PORT);
  try {
    await Promise.all([
      waitForHealth(`http://127.0.0.1:${STATIC_PORT}/health`),
      waitForHealth(`http://127.0.0.1:${DYNAMIC_PORT}/health`),
    ]);

    const staticClient = new McpClient(`http://127.0.0.1:${STATIC_PORT}/mcp`, 'static', { correlationId: CORRELATION_ID });
    const dynamicClient = new McpClient(`http://127.0.0.1:${DYNAMIC_PORT}/mcp`, 'dynamic', { correlationId: CORRELATION_ID });

    // Success path: a real, tiny candidateScan.
    await staticClient.callTool('candidateScan', { filePath: 'smoke.c', content: 'int main(){ void *p = malloc(1); return 0; }' });
    // Deliberate failure path: `exit 1` inside the repo root (passes WORKSPACE_ROOT
    // containment — the server defaults it to cwd outside Docker — but the build
    // itself fails), so this exercises BUILD_FAILED, not just a path rejection.
    await dynamicClient.callTool('buildTarget', { projectPath: process.cwd(), buildCommand: 'exit 1' }).catch(() => undefined);

    await staticClient.close();
    await dynamicClient.close();
    await sleep(300); // let stdio flush

    const staticEvents = parseJsonLines(staticSrv.lines());
    const dynamicEvents = parseJsonLines(dynamicSrv.lines());

    if (staticEvents.length === 0) throw new Error('static-analyzer produced no JSON log lines at all — logging is silent');
    if (dynamicEvents.length === 0) throw new Error('dynamic-analyzer produced no JSON log lines at all — logging is silent');

    assertPaired(staticEvents, 'mcp_tool_started', ['mcp_tool_finished', 'mcp_tool_failed'], 'static-analyzer');
    assertPaired(dynamicEvents, 'mcp_tool_started', ['mcp_tool_finished', 'mcp_tool_failed'], 'dynamic-analyzer');

    const toolScoped = [...staticEvents, ...dynamicEvents].filter((e) => typeof e.tool === 'string');
    if (toolScoped.length === 0) throw new Error('no tool-scoped log line found at all');
    const uncorrelated = toolScoped.filter((e) => e.correlationId !== CORRELATION_ID);
    if (uncorrelated.length > 0) throw new Error(`${uncorrelated.length} tool-scoped log line(s) missing the expected correlationId — x-scan-id propagation broke`);

    const buildFailed = dynamicEvents.find((e) => e.event === 'build_failed');
    if (!buildFailed) throw new Error('the deliberate buildTarget failure did not produce a "build_failed" event — failures are silent again');

    console.log(
      `✓ logging smoke test passed — ${staticEvents.length} static + ${dynamicEvents.length} dynamic structured log lines, ` +
        `all tool-scoped lines correlated, started/finished pairs matched, deliberate failure traced.`,
    );
  } finally {
    staticSrv.proc.kill();
    dynamicSrv.proc.kill();
  }
}

main().catch((err) => {
  console.error(`✗ logging smoke test FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
