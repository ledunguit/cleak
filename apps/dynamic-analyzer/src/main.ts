import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join, resolve } from 'path';
import { DynamicAnalyzerModule } from './dynamic-analyzer.module';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';

// Load .env from apps/dynamic-analyzer/.env (cwd = repo root when run via turbo)
const envPath = resolve('apps/dynamic-analyzer/.env');
if (existsSync(envPath)) dotenv.config({ path: envPath });

const PROTO_DIR = process.env.PROTO_DIR
  ? resolve(process.env.PROTO_DIR)
  : join(process.cwd(), 'proto');

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    DynamicAnalyzerModule,
    {
      transport: Transport.GRPC,
      options: {
        package: 'dynamic_analyzer',
        protoPath: join(PROTO_DIR, 'dynamic-analyzer.proto'),
        url: process.env.GRPC_URL || '0.0.0.0:50052',
      },
    },
  );

  await app.listen();
  console.log('Dynamic analyzer gRPC server listening on port 50052');
}

bootstrap();
