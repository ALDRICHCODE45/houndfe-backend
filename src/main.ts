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
import { createListingValidationExceptionFactory } from './shared/listing/listing-validation-exception.factory';
import {
  installBotApplicationOutcomeBodyParser,
  installHumanDecisionBodyParser,
} from './human-decisions/presentation/filters/human-decision-body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Global validation pipe — validates all incoming DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties
      forbidNonWhitelisted: true, // throw on unknown properties
      transform: true, // auto-transform payloads to DTO instances
      exceptionFactory: createListingValidationExceptionFactory(),
    }),
  );

  // Global exception filter — maps DomainErrors to HTTP responses
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new PrismaExceptionFilter(),
  );

  // CORS — orígenes desde CORS_ORIGINS (lista separada por comas).
  // En producción debe estar seteado con los orígenes legítimos
  // (p.ej. https://sistem.houndfe.com,http://localhost:4173).
  // Sin la variable se permite todo con warning (fallback de desarrollo).
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (corsOrigins.length > 0) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  } else {
    logger.warn(
      'CORS_ORIGINS no definido — CORS abierto a cualquier origen (solo para desarrollo)',
    );
    app.enableCors();
  }

  // HD-04d2a — sanitize malformed/primitive bodies on the `/human-decisions`
  // routes BEFORE Nest's default parser mounts them. `enableCors` registers the
  // CORS middleware synchronously in BOTH branches above, so mounting the
  // route-scoped parser HERE — after the whole CORS branch and still before
  // `app.listen` -> Nest init — lets a malformed-body short-circuit carry the
  // `Access-Control-Allow-Origin` header the allowlisted browser FE requires.
  installHumanDecisionBodyParser(app);

  // HD-05c2a — the bot terminal ACK body (`POST /chatbot-api/human-decisions/:
  // id/application-outcome`) is validated by the exact pure parser, but Nest's
  // default `json` parser (`strict: true`) would reject a JSON primitive or
  // echo a raw body snippet on a malformed body before the controller-scoped
  // filter can run. Mount the route-scoped parser AFTER CORS and BEFORE
  // `app.listen` -> Nest init, with an EXACT method+path gate so the bot
  // intake/poll and every other route keep the default parsers.
  installBotApplicationOutcomeBodyParser(app);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application running on http://localhost:${port}`);
}
bootstrap();
