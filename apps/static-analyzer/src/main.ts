import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { resolve } from 'path';
import { StaticAnalyzerModule } from './static-analyzer.module';
import { createStaticMcpServer } from './mcp/static-mcp-server';
import { startMcpHttp } from '@cleak/common/mcp/mcp-http';
import { createRootLogger, PinoNestLogger } from '@cleak/observability';
import { FileIndexingService } from './services/file-indexing.service';
import { CandidateScanService } from './services/candidate-scan.service';
import { AstScanService } from './services/ast-scan.service';
import { CallGraphService } from './services/call-graph.service';
import { FunctionSummaryService } from './services/function-summary.service';
import { InterproceduralFlowService } from './services/interprocedural-flow.service';
import { PathConstraintsService } from './services/path-constraints.service';
import { OwnershipAnalysisService } from './services/ownership-analysis.service';
import { ScanBuildAdapterService } from './services/scan-build-adapter.service';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';

// Load .env from apps/static-analyzer/.env (cwd = repo root when run via turbo)
const envPath = resolve('apps/static-analyzer/.env');
if (existsSync(envPath)) dotenv.config({ path: envPath });

const logger = createRootLogger({ label: 'static-analyzer' });

/** Build the MCP server from the DI-resolved analysis services and serve it over HTTP. */
async function serveMcp(ctx: INestApplicationContext) {
  // Services are DI singletons; only the thin McpServer wrapper is rebuilt per request.
  const svc = {
    fileIndexing: ctx.get(FileIndexingService),
    candidateScan: ctx.get(CandidateScanService),
    astScan: ctx.get(AstScanService),
    callGraph: ctx.get(CallGraphService),
    functionSummary: ctx.get(FunctionSummaryService),
    interproceduralFlow: ctx.get(InterproceduralFlowService),
    pathConstraints: ctx.get(PathConstraintsService),
    ownership: ctx.get(OwnershipAnalysisService),
    scanBuild: ctx.get(ScanBuildAdapterService),
  };
  await startMcpHttp(() => createStaticMcpServer(svc, logger), Number(process.env.MCP_HTTP_PORT || 50061), 'static-analyzer', logger);
}

async function bootstrap() {
  // MCP/HTTP is the ONLY transport — the leak-inspector-tui orchestrator drives this
  // analyzer over MCP. (A gRPC server lived here for the removed web control-plane;
  // it had no consumer once the project went TUI-only, so it was dropped along with
  // the proto schemas. The DI context just resolves the analysis services.)
  // Pass the logger via factory options (not a later `ctx.useLogger()` call) —
  // module init (onModuleInit, e.g. CParserService's worker-pool startup log)
  // runs INSIDE createApplicationContext, before it returns, so setting the
  // logger afterward would miss bootstrap-time logs and leave them on Nest's
  // default console format instead of structured JSON.
  const ctx = await NestFactory.createApplicationContext(StaticAnalyzerModule, { logger: new PinoNestLogger(logger) });
  await serveMcp(ctx);
}

bootstrap();
