import { NestFactory } from '@nestjs/core';
import { ControlPlaneModule } from './control-plane.module';

// Last-resort net: a detached scan pipeline should never crash the process.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason);
});

async function bootstrap() {
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
