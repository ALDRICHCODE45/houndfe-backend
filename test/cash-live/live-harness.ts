/**
 * cash-live harness — NestJS TestingModule composition.
 *
 * Module boundary (exact, no overclaiming):
 *   - ConfigModule (global, `ignoreEnvFile` + `skipProcessEnv: true`) with
 *     ONLY explicit fictional config — no .env, no Joi env schema, and
 *     ConfigService NEVER falls back to process.env, so an inherited
 *     RESEND_API_KEY (or any other real env value) is invisible to the
 *     graph;
 *   - ClsModule (global, middleware) — same tenant CLS store as production;
 *   - DatabaseModule — real PrismaService/TenantPrismaService;
 *   - AuthModule — FULLY REAL and transitively includes MailerModule/
 *     ResendMailer and the AuthController routes; JwtStrategy,
 *     JwtAuthGuard, PermissionsGuard, CaslAbilityFactory and the
 *     PermissionSeeder are the production implementations. External email
 *     is prevented by THREE independent layers: (1) `skipProcessEnv` +
 *     explicit config (no API key visible), (2) the pre-compile
 *     `checkDeniedExternalEnv` guard in server.ts, and (3) the narrow
 *     test-only MAILER override below whose `send` always throws.
 *   - CashRegisterModule — real controllers + real application adapter.
 *
 * The ONLY provider override in this harness is the MAILER port (offline
 * no-send implementation) — auth guards, tenant CLS, Prisma and the cash
 * application remain the real production code. Not every service is
 * absent: AuthModule's login/refresh/OTP routes are mounted, but the OTP
 * send path fails closed through the offline MAILER, so no network egress
 * is possible from any mounted route.
 *
 * The scout's finding is honored: CashRegisterModule is transitively
 * loaded by Sales/PDF inside AppModule in production — this harness does
 * NOT "fix" that wiring; it imports CashRegisterModule directly, which is
 * the same module instance production uses.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { DatabaseModule } from '../../src/shared/prisma/prisma.module';
import { AuthModule } from '../../src/auth/auth.module';
import { CashRegisterModule } from '../../src/cash-register/cash-register.module';
import { JwtService } from '@nestjs/jwt';
import { createAppValidationPipe } from '../../src/shared/listing/app-validation.pipe';
import { DomainExceptionFilter } from '../../src/shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../src/shared/filters/prisma-exception.filter';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import {
  MAILER,
  type IMailer,
} from '../../src/notifications/email/mailer.port';
import type { LiveHarnessConfig } from './live-config';
import { signActorTokens, type ActorTokens } from './tokens';
import type { SeedResult } from './seed';
import {
  applyResumeModuleOverrides,
  type LiveModuleResumeOptions,
} from './resume-startup';

/**
 * Test-only offline MAILER implementation. Fail closed: every send
 * throws with a FIXED message (input is never echoed). This is the only
 * replacement provider in the harness.
 */
export class OfflineNoSendMailer implements IMailer {
  send(): Promise<void> {
    return Promise.reject(
      new Error(
        'cash-live harness: outbound email is disabled (offline MAILER override)',
      ),
    );
  }
}

/** Compile the real module graph with explicit fictional config.
 *
 * `options.resume` is an EXPLICIT resume flag supplied by `server.ts` from
 * the validated resume config. It is never inferred from ambient env or
 * from `LiveHarnessConfig`. When `resume: true`, the production
 * PermissionSeeder bootstrap writer is replaced by a no-op for this run
 * only (see `applyResumeModuleOverrides`); fresh runs are unchanged.
 */
export async function createLiveTestingModule(
  config: LiveHarnessConfig,
  options: LiveModuleResumeOptions = {},
): Promise<TestingModule> {
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        // NEVER load .env in the harness — the run environment is explicit.
        ignoreEnvFile: true,
        // NEVER fall back to process.env — an inherited RESEND_API_KEY or
        // any other real value must stay invisible to the module graph.
        skipProcessEnv: true,
        load: [
          () => ({
            JWT_SECRET: config.jwtSecret,
            JWT_ACCESS_EXPIRATION: config.accessTokenExpiresIn,
          }),
        ],
      }),
      ClsModule.forRoot({
        global: true,
        middleware: { mount: true },
      }),
      DatabaseModule,
      AuthModule,
      CashRegisterModule,
    ],
  })
    // Narrow test-only override: the offline MAILER can never send.
    .overrideProvider(MAILER)
    .useClass(OfflineNoSendMailer);
  // Resume-only override: never write authorization rows on restart.
  applyResumeModuleOverrides(builder, options);
  return builder.compile();
}

/** Apply the same global pipe/filters as `src/main.ts`, then CORS. */
export function configureLiveApp(
  app: INestApplication,
  config: LiveHarnessConfig,
): void {
  app.useGlobalPipes(createAppValidationPipe());
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new PrismaExceptionFilter(),
  );
  app.enableCors({ origin: config.frontendOrigin, credentials: true });
}

/**
 * Sign the final JWT payload for each fictional actor with the module's
 * real JwtService (same secret/strategy as production). Payload shape is
 * the production `JwtTokenPayload`: sub, email, tenantId, tenantSlug,
 * isSuperAdmin:false. Tokens stay in memory; they are never logged.
 */
export function issueActorTokens(
  moduleRef: TestingModule,
  seed: SeedResult,
  config: LiveHarnessConfig,
): ActorTokens {
  const jwtService = moduleRef.get(JwtService);
  const configService = moduleRef.get(ConfigService);
  // Fail closed if the harness config and the strategy secret ever diverge.
  const strategySecret = configService.getOrThrow<string>('JWT_SECRET');
  if (strategySecret !== config.jwtSecret) {
    throw new Error(
      'JWT secret mismatch between harness config and AuthModule',
    );
  }
  return signActorTokens(jwtService, seed, config);
}

/** Convenience accessor for the real PrismaService. */
export function prismaOf(moduleRef: TestingModule): PrismaService {
  return moduleRef.get(PrismaService);
}
