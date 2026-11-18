/**
 * editorial-live harness — NestJS TestingModule composition.
 *
 * Module boundary (exact):
 *   - ConfigModule (global, `ignoreEnvFile` + `skipProcessEnv`) with ONLY
 *     explicit fictional config (JWT secret + access TTL) — no .env and no
 *     process.env fallback, exactly like cash-live;
 *   - ClsModule (global, middleware) — production tenant CLS;
 *   - EventEmitterModule.forRoot() — required by ProductsModule's
 *     OutboxModule (EventEmitter2). No ScheduleModule: outbox pollers never
 *     tick; no Inngest module;
 *   - DatabaseModule — real PrismaService / TenantPrismaService;
 *   - AuthModule — real JwtStrategy/JwtAuthGuard/PermissionsGuard/CASL and
 *     PermissionSeeder (bootstrap upserts the registry + Super Admin role);
 *   - CatalogEditorialReadModule (read, readiness, initialize, save,
 *     publish, discard, unpublish) + CatalogEditorialVocabularyModule
 *     (vocabulary, context) — the 9 editorial routes, unchanged;
 *   - ProductsModule — `GET /products/:id` (+ its transitive Files/SAT/
 *     StockAlerts/Outbox/Inventory modules).
 *
 * Provider overrides (offline only; auth, tenant CLS, Prisma and the
 * editorial/products application stay real):
 *   - MAILER -> cash-live's OfflineNoSendMailer (every send throws);
 *   - 'S3_CLIENT' + STORAGE_PORT -> offline stubs that refuse every call
 *     (FilesModule otherwise demands SPACES_* credentials at compile time).
 *
 * HTTP: the same global pipe/filters as src/main.ts and the production
 * `editorialCors` delegate with ONE allowed origin (`frontendOrigin`).
 */
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { AuthModule } from '../../src/auth/auth.module';
import { CatalogEditorialReadModule } from '../../src/catalog-editorial/catalog-editorial-read.module';
import { CatalogEditorialVocabularyModule } from '../../src/catalog-editorial/catalog-editorial-vocabulary.module';
import { editorialCors } from '../../src/catalog-editorial/http/editorial-cors';
import {
  STORAGE_PORT,
  type IStoragePort,
} from '../../src/files/domain/storage.port';
import { MAILER } from '../../src/notifications/email/mailer.port';
import { ProductsModule } from '../../src/products/products.module';
import { DomainExceptionFilter } from '../../src/shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../src/shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../../src/shared/listing/app-validation.pipe';
import { DatabaseModule } from '../../src/shared/prisma/prisma.module';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import type { LiveHarnessConfig } from '../cash-live/live-config';
import { OfflineNoSendMailer } from '../cash-live/offline-mailer';
import type { EditorialSeedResult } from './seed';
import { signEditorialActorTokens, type EditorialActorTokens } from './tokens';

const STORAGE_DISABLED =
  'editorial-live harness: object storage is disabled (offline override)';

/** Offline storage: every operation fails closed with a FIXED message. */
export class OfflineNoStorage implements IStoragePort {
  upload(): Promise<never> {
    return Promise.reject(new Error(STORAGE_DISABLED));
  }
  delete(): Promise<void> {
    return Promise.reject(new Error(STORAGE_DISABLED));
  }
  getPublicUrl(): string {
    throw new Error(STORAGE_DISABLED);
  }
}

/** Stand-in for the S3 client token; any `send` fails closed. */
export const OFFLINE_S3_CLIENT = Object.freeze({
  send: () => Promise.reject(new Error(STORAGE_DISABLED)),
});

export async function createEditorialLiveTestingModule(
  config: LiveHarnessConfig,
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [
          () => ({
            JWT_SECRET: config.jwtSecret,
            JWT_ACCESS_EXPIRATION: config.accessTokenExpiresIn,
          }),
        ],
      }),
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      EventEmitterModule.forRoot(),
      DatabaseModule,
      AuthModule,
      CatalogEditorialReadModule,
      CatalogEditorialVocabularyModule,
      ProductsModule,
    ],
  })
    .overrideProvider(MAILER)
    .useClass(OfflineNoSendMailer)
    .overrideProvider('S3_CLIENT')
    .useValue(OFFLINE_S3_CLIENT)
    .overrideProvider(STORAGE_PORT)
    .useClass(OfflineNoStorage)
    .compile();
}

/** Same global pipe/filters as src/main.ts; editorial CORS, single origin. */
export function configureEditorialLiveApp(
  app: INestApplication,
  config: LiveHarnessConfig,
): void {
  app.useGlobalPipes(createAppValidationPipe());
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new PrismaExceptionFilter(),
  );
  app.enableCors(
    editorialCors({ origin: config.frontendOrigin, credentials: true }),
  );
}

/** Sign actor tokens with the module's real JwtService (secrets must match). */
export function issueEditorialActorTokens(
  moduleRef: TestingModule,
  seed: EditorialSeedResult,
  config: LiveHarnessConfig,
): EditorialActorTokens {
  const strategySecret = moduleRef
    .get(ConfigService)
    .getOrThrow<string>('JWT_SECRET');
  if (strategySecret !== config.jwtSecret) {
    throw new Error(
      'JWT secret mismatch between harness config and AuthModule',
    );
  }
  return signEditorialActorTokens(moduleRef.get(JwtService), seed, config);
}

export function prismaOf(moduleRef: TestingModule): PrismaService {
  return moduleRef.get(PrismaService);
}
