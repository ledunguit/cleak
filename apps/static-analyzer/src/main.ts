import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join, resolve } from 'path';
import { StaticAnalyzerModule } from './static-analyzer.module';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';

// Load .env from apps/static-analyzer/.env (cwd = repo root when run via turbo)
const envPath = resolve('apps/static-analyzer/.env');
if (existsSync(envPath)) dotenv.config({ path: envPath });

const PROTO_DIR = process.env.PROTO_DIR
  ? resolve(process.env.PROTO_DIR)
  : join(process.cwd(), 'proto');

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    StaticAnalyzerModule,
    {
      transport: Transport.GRPC,
      options: {
        package: 'static_analyzer',
        protoPath: join(PROTO_DIR, 'static-analyzer.proto'),
        url: process.env.GRPC_URL || '0.0.0.0:50051',
      },
    },
  );

  await app.listen();
  console.log('Static analyzer gRPC server listening on port 50051');
}

bootstrap();
