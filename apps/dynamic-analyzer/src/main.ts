import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { resolve } from 'path';
import { DynamicAnalyzerModule } from './dynamic-analyzer.module';
import { createDynamicMcpServer } from './mcp/dynamic-mcp-server';
import { startMcpHttp } from '@cleak/common/mcp/mcp-http';
import { createRootLogger, PinoNestLogger } from '@cleak/observability';
import { BuildTargetService } from './services/build-target.service';
import { ValgrindService } from './services/valgrind.service';
import { AsanService } from './services/asan.service';
import { LsanService } from './services/lsan.service';
import { BinaryRunnerService } from './services/binary-runner.service';
import { CompareService } from './services/compare.service';
import { RunManagerService } from './services/run-manager.service';
import { HarnessBuildService } from './services/harness-build.service';
import { LibfuzzerRunService } from './services/libfuzzer-run.service';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';

// Load .env from apps/dynamic-analyzer/.env (cwd = repo root when run via turbo)
const envPath = resolve('apps/dynamic-analyzer/.env');
if (existsSync(envPath)) dotenv.config({ path: envPath });

const logger = createRootLogger({ label: 'dynamic-analyzer' });

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
    harnessBuild: ctx.get(HarnessBuildService),
    libfuzzerRun: ctx.get(LibfuzzerRunService),
  };
  await startMcpHttp(() => createDynamicMcpServer(svc, logger), Number(process.env.MCP_HTTP_PORT || 50062), 'dynamic-analyzer', logger);
}

async function bootstrap() {
  // MCP/HTTP is the ONLY transport — the leak-inspector-tui orchestrator drives this
  // analyzer over MCP. (A gRPC server lived here for the removed web control-plane;
  // it had no consumer once the project went TUI-only, so it was dropped along with
  // the proto schemas. The DI context just resolves the analysis services.)
  // Pass the logger via factory options (not a later `ctx.useLogger()` call) —
  // module init (onModuleInit) runs INSIDE createApplicationContext, before it
  // returns, so setting the logger afterward would miss bootstrap-time logs and
  // leave them on Nest's default console format instead of structured JSON.
  const ctx = await NestFactory.createApplicationContext(DynamicAnalyzerModule, { logger: new PinoNestLogger(logger) });
  await serveMcp(ctx);
}

bootstrap();
