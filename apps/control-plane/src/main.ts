import { NestFactory } from '@nestjs/core';
import { ControlPlaneModule } from './control-plane.module';

// Last-resort net: a detached scan pipeline should never crash the process.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason);
});

const DEFAULT_JWT_SECRET = 'mcpvul-dev-secret-change-in-production';

/** Loudly flag insecure defaults so a dev config is never silently shipped. */
function warnInsecureDefaults() {
  const warn = (m: string) => console.warn(`[security] ${m}`);
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET) {
    warn('JWT_SECRET is the built-in default — set a strong JWT_SECRET before any non-local use.');
  }
  if (process.env.DB_SYNC === 'true') {
    warn('DB_SYNC=true — TypeORM auto-sync is on; use migrations for any persistent database.');
  }
  if (!process.env.TOKEN_ENC_KEY) {
    warn('TOKEN_ENC_KEY is unset — GitHub OAuth tokens are stored UNENCRYPTED at rest.');
  }
}

async function bootstrap() {
  warnInsecureDefaults();
  const app = await NestFactory.create(ControlPlaneModule);

  // Graceful shutdown so the BullMQ worker drains/closes cleanly (in-flight jobs
  // become stalled and are resumed on the next boot rather than lost).
  app.enableShutdownHooks();

  // CORS for frontend dev server
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  const port = process.env.PORT || 8090;
  await app.listen(port);

  // Scans now return immediately (run detached on the queue), so the only
  // intentionally long-lived connection is the SSE event stream — keep the
  // server from reaping it. requestTimeout=0 removes the 300s default cap.
  const server = app.getHttpServer();
  server.keepAliveTimeout = Number(process.env.HTTP_KEEPALIVE_TIMEOUT_MS ?? 65000);
  server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS ?? 70000); // must exceed keepAliveTimeout
  server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS ?? 0);

  console.log(`Control plane listening on http://localhost:${port}`);
}

bootstrap();
