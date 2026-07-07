/**
 * TenantModule — NestJS module for shared tenant infrastructure.
 *
 * Owns the `ClsModule` is set up globally via `app.module.ts`, but
 * the `TenantRunnerService` itself is still a `@Injectable` —
 * NOTHING exports it across module boundaries until this module
 * is imported. Feature modules that run inside non-HTTP entry
 * points (Inngest handlers, scheduled jobs, outbox dispatchers)
 * import `TenantModule` to seed the CLS scope from event payloads.
 *
 * Currently exported:
 *   - `TenantRunnerService` (runWithTenant — Slice D.1)
 *   - `SYSTEM_ACTOR_ID` constant (re-exported as a provider token
 *     so consumers don't need a direct path import).
 *
 * Mirrors `src/shared/prisma/prisma.module.ts` (DatabaseModule) in
 * flavor — both are thin wiring modules for shared infra services.
 */
import { Module } from '@nestjs/common';
import { TenantRunnerService } from './tenant-runner.service';

@Module({
  providers: [TenantRunnerService],
  exports: [TenantRunnerService],
})
export class TenantModule {}
