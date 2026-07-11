/**
 * InngestModule — NestJS wiring for the Inngest integration.
 *
 * Owns:
 *   - `InngestService` (D.2): the Inngest client wrapper (send / getFunctions).
 *   - `InngestController` (D.3): the `/api/inngest` HTTP handler that
 *     delegates to `serve({ client, functions, signingKey })` from
 *     `inngest/express`. JWT-excluded — the Inngest SDK's signature
 *     verification is the only auth gate (D.3 spec).
 *
 * **Module placement.** Registered in `app.module.ts` as a top-level
 * feature module, alongside `SatCatalogModule` and `NotificationConfigModule`.
 *
 * **Out of scope for D.** No functions are registered yet — `getFunctions()`
 * returns `[]`. Slice F (low-stock.functions.ts) will inject
 * `InngestService` and call `inngest.createFunction(...)` to register
 * the low-stock-email function. We deliberately do not pre-build that
 * here so D stays reviewable (this module owns infra only; Slice F owns
 * the function business logic).
 *
 * Spec: design.md "Inngest + Resend Wiring".
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InngestController } from './inngest.controller';
import { InngestService } from './inngest.service';

@Module({
  imports: [ConfigModule],
  controllers: [InngestController],
  providers: [InngestService],
  // Slice F will import InngestModule to inject InngestService into the
  // low-stock functions / dedicated dispatcher.
  exports: [InngestService],
})
export class InngestModule {}
