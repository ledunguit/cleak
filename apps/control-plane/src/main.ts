import { NestFactory } from '@nestjs/core';
import { ControlPlaneModule } from './control-plane.module';

async function bootstrap() {
  const app = await NestFactory.create(ControlPlaneModule);

  // CORS for frontend dev server
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  const port = process.env.PORT || 8090;
  await app.listen(port);
  console.log(`Control plane listening on http://localhost:${port}`);
}

bootstrap();
