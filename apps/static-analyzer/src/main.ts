import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import type { INestApplicationContext } from '@nestjs/common';
import { join, resolve } from 'path';
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
import { LeakGuardAdapterService } from './services/leakguard-adapter.service';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';

// Load .env from apps/static-analyzer/.env (cwd = repo root when run via turbo)
const envPath = resolve('apps/static-analyzer/.env');
if (existsSync(envPath)) dotenv.config({ path: envPath });

const PROTO_DIR = process.env.PROTO_DIR
  ? resolve(process.env.PROTO_DIR)
  : join(process.cwd(), 'proto');

// 'grpc' (default) | 'mcp' | 'both' — controls which transport(s) this server exposes.
const TRANSPORT_MODE = (process.env.TRANSPORT_MODE || 'grpc').toLowerCase();

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
    leakguard: ctx.get(LeakGuardAdapterService),
  };
  await startMcpHttp(() => createStaticMcpServer(svc), Number(process.env.MCP_HTTP_PORT || 50061), 'static-analyzer');
}

async function bootstrap() {
  if (TRANSPORT_MODE === 'grpc' || TRANSPORT_MODE === 'both') {
    const app = await NestFactory.createMicroservice<MicroserviceOptions>(StaticAnalyzerModule, {
      transport: Transport.GRPC,
      options: {
        package: 'static_analyzer',
        protoPath: join(PROTO_DIR, 'static-analyzer.proto'),
        url: process.env.GRPC_URL || '0.0.0.0:50051',
      },
    });
    await app.listen();
    console.log('Static analyzer gRPC server listening on port 50051');
    if (TRANSPORT_MODE === 'both') await serveMcp(app);
  } else {
    // MCP-only: no gRPC listener, just a DI context to resolve the services.
    const ctx = await NestFactory.createApplicationContext(StaticAnalyzerModule);
    await serveMcp(ctx);
  }
}

bootstrap();
