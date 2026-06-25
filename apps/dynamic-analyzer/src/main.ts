import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { resolve } from 'path';
import { DynamicAnalyzerModule } from './dynamic-analyzer.module';
import { createDynamicMcpServer } from './mcp/dynamic-mcp-server';
import { startMcpHttp } from './mcp/mcp-http';
import { BuildTargetService } from './services/build-target.service';
import { ValgrindService } from './services/valgrind.service';
import { AsanService } from './services/asan.service';
import { LsanService } from './services/lsan.service';
import { BinaryRunnerService } from './services/binary-runner.service';
import { CompareService } from './services/compare.service';
import { RunManagerService } from './services/run-manager.service';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';

// Load .env from apps/dynamic-analyzer/.env (cwd = repo root when run via turbo)
const envPath = resolve('apps/dynamic-analyzer/.env');
if (existsSync(envPath)) dotenv.config({ path: envPath });

/** Build the MCP server from the DI-resolved services and serve it over HTTP. */
async function serveMcp(ctx: INestApplicationContext) {
  // Services are DI singletons; only the thin McpServer wrapper is rebuilt per request.
  const svc = {
    buildTarget: ctx.get(BuildTargetService),
    valgrind: ctx.get(ValgrindService),
    asan: ctx.get(AsanService),
    lsan: ctx.get(LsanService),
    binaryRunner: ctx.get(BinaryRunnerService),
    compare: ctx.get(CompareService),
    runManager: ctx.get(RunManagerService),
  };
  await startMcpHttp(() => createDynamicMcpServer(svc), Number(process.env.MCP_HTTP_PORT || 50062), 'dynamic-analyzer');
}

async function bootstrap() {
  // MCP/HTTP is the ONLY transport — the leak-inspector-tui orchestrator drives this
  // analyzer over MCP. (A gRPC server lived here for the removed web control-plane;
  // it had no consumer once the project went TUI-only, so it was dropped along with
  // the proto schemas. The DI context just resolves the analysis services.)
  const ctx = await NestFactory.createApplicationContext(DynamicAnalyzerModule);
  await serveMcp(ctx);
}

bootstrap();
