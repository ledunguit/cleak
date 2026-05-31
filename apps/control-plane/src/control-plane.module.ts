import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { join, resolve } from 'path';
import {
  ScanEntity,
  WorkspaceEntity,
  RepositoryEntity,
  GitHubConnectionEntity,
  UserEntity,
} from '@mcpvul/common';

const PROTO_DIR = process.env.PROTO_DIR
  ? resolve(process.env.PROTO_DIR)
  : join(process.cwd(), 'proto');
import { ScanController } from './controllers/scan.controller';
import { WorkspaceController } from './controllers/workspace.controller';
import { GitHubController } from './controllers/github.controller';
import { LogsController } from './controllers/logs.controller';
import { AuthController } from './controllers/auth.controller';
import { RuntimeController } from './controllers/runtime.controller';
import { ScanService } from './services/scan.service';
import { CandidateManagerService } from './services/candidate-manager.service';
import { JudgeService } from './services/judge.service';
import { ReportingService } from './services/reporting.service';
import { DynamicPlannerService } from './services/dynamic-planner.service';
import { InvestigationPolicyService } from './services/investigation-policy.service';
import { PersistenceService } from './services/persistence.service';
import { GitHubService } from './services/github.service';
import { LogCollectorService } from './services/log-collector.service';
import { AuthService } from './services/auth.service';
import { LlmAnalyzerService } from './services/llm-analyzer.service';
import { BuildDiscoveryService } from './services/build-discovery.service';
import { ToolRegistryService } from './services/tool-registry.service';
import { ScanOrchestratorService } from './services/scan-orchestrator.service';
import { InvestigationPlannerService } from './services/investigation-planner.service';
import { ScanWorkspaceService } from './services/scan-workspace.service';
import { RuntimeDiagnosticsService } from './services/runtime-diagnostics.service';
import { McpClientManager } from './services/mcp-client-manager.service';
import { ScanProcessor, SCAN_QUEUE } from './services/scan.processor';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: 'apps/control-plane/.env' }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('POSTGRES_HOST', 'localhost'),
        port: config.get('POSTGRES_PORT', 5432),
        username: config.get('POSTGRES_USER', 'mcpvul'),
        password: config.get('POSTGRES_PASSWORD', 'mcpvul'),
        database: config.get('POSTGRES_DB', 'mcpvul'),
        autoLoadEntities: true,
        synchronize: config.get('DB_SYNC', 'true') === 'true',
      }),
    }),
    TypeOrmModule.forFeature([
      ScanEntity,
      WorkspaceEntity,
      RepositoryEntity,
      GitHubConnectionEntity,
      UserEntity,
    ]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET', 'mcpvul-dev-secret-change-in-production'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
    // gRPC client for static-analyzer
    ClientsModule.registerAsync([
      {
        name: 'STATIC_ANALYZER_PACKAGE',
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            package: 'static_analyzer',
            protoPath: join(PROTO_DIR, 'static-analyzer.proto'),
            url: config.get('STATIC_ANALYZER_URL', 'localhost:50051'),
          },
        }),
      },
      // gRPC client for dynamic-analyzer
      {
        name: 'DYNAMIC_ANALYZER_PACKAGE',
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            package: 'dynamic_analyzer',
            protoPath: join(PROTO_DIR, 'dynamic-analyzer.proto'),
            url: config.get('DYNAMIC_ANALYZER_URL', 'localhost:50052'),
          },
        }),
      },
    ]),
    // BullMQ on Redis — durable scan job queue; scans run on an in-process worker.
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST', 'localhost'),
          port: Number(config.get('REDIS_PORT', 6379)),
        },
      }),
    }),
    BullModule.registerQueue({ name: SCAN_QUEUE }),
  ],
  controllers: [
    ScanController,
    WorkspaceController,
    GitHubController,
    LogsController,
    AuthController,
    RuntimeController,
  ],
  providers: [
    ScanService,
    CandidateManagerService,
    JudgeService,
    ReportingService,
    DynamicPlannerService,
    InvestigationPolicyService,
    PersistenceService,
    GitHubService,
    LogCollectorService,
    AuthService,
    LlmAnalyzerService,
    BuildDiscoveryService,
    ToolRegistryService,
    ScanOrchestratorService,
    InvestigationPlannerService,
    ScanWorkspaceService,
    RuntimeDiagnosticsService,
    McpClientManager,
    ScanProcessor,
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class ControlPlaneModule {}
