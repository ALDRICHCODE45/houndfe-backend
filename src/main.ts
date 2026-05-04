/**
 * Bootstrap - Application entry point.
 *
 * Configures:
 * - ValidationPipe: auto-validates DTOs via class-validator
 * - DomainExceptionFilter: maps domain errors to HTTP responses
 * - PrismaExceptionFilter: maps Prisma known errors to HTTP responses
 */
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from './shared/filters/prisma-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Global validation pipe — validates all incoming DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties
      forbidNonWhitelisted: true, // throw on unknown properties
      transform: true, // auto-transform payloads to DTO instances
    }),
  );

  // Global exception filter — maps DomainErrors to HTTP responses
  app.useGlobalFilters(new DomainExceptionFilter(), new PrismaExceptionFilter());

  // CORS — permite todas las origenes (solo para desarrollo)
  app.enableCors();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application running on http://localhost:${port}`);
}
bootstrap();
