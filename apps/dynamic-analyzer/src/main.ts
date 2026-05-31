import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import type { INestApplicationContext } from '@nestjs/common';
import { join, resolve } from 'path';
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

const PROTO_DIR = process.env.PROTO_DIR
  ? resolve(process.env.PROTO_DIR)
  : join(process.cwd(), 'proto');

// 'grpc' (default) | 'mcp' | 'both' — controls which transport(s) this server exposes.
const TRANSPORT_MODE = (process.env.TRANSPORT_MODE || 'grpc').toLowerCase();

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
  if (TRANSPORT_MODE === 'grpc' || TRANSPORT_MODE === 'both') {
    const app = await NestFactory.createMicroservice<MicroserviceOptions>(DynamicAnalyzerModule, {
      transport: Transport.GRPC,
      options: {
        package: 'dynamic_analyzer',
        protoPath: join(PROTO_DIR, 'dynamic-analyzer.proto'),
        url: process.env.GRPC_URL || '0.0.0.0:50052',
      },
    });
    await app.listen();
    console.log('Dynamic analyzer gRPC server listening on port 50052');
    if (TRANSPORT_MODE === 'both') await serveMcp(app);
  } else {
    const ctx = await NestFactory.createApplicationContext(DynamicAnalyzerModule);
    await serveMcp(ctx);
  }
}

bootstrap();
