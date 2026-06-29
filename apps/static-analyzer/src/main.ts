import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { resolve } from 'path';
import { StaticAnalyzerModule } from './static-analyzer.module';
import { createStaticMcpServer } from './mcp/static-mcp-server';
import { startMcpHttp } from './mcp/mcp-http';
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
  await startMcpHttp(() => createStaticMcpServer(svc), Number(process.env.MCP_HTTP_PORT || 50061), 'static-analyzer');
}

async function bootstrap() {
  // MCP/HTTP is the ONLY transport — the leak-inspector-tui orchestrator drives this
  // analyzer over MCP. (A gRPC server lived here for the removed web control-plane;
  // it had no consumer once the project went TUI-only, so it was dropped along with
  // the proto schemas. The DI context just resolves the analysis services.)
  const ctx = await NestFactory.createApplicationContext(StaticAnalyzerModule);
  await serveMcp(ctx);
}

bootstrap();
