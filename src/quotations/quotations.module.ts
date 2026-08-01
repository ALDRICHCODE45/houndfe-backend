/**
 * QuotationsModule — NestJS module for the Quotations bounded context.
 *
 * WU3 — wires the engine port (`POS_EVALUATE_PROMOTIONS_USE_CASE`) +
 * the `ProductsService` for tier-aware repricing. The `PromotionsModule`
 * provides the engine via Symbol token (matches SalesModule's wiring).
 *
 * WU4 — adds `MailerModule` (so `QuotationsService.send` can call
 * `MAILER.send`) and `PdfGenerationModule` (so the send flow can
 * render the PDF in-memory without going through the HTTP boundary).
 *
 * Provider bindings:
 *   - `QuotationsService`              — use-case orchestrator.
 *   - `{ QUOTATION_REPOSITORY → PrismaQuotationRepository }` — persistence port.
 *
 * Imports:
 *   - `AuthModule` — provides `JwtAuthGuard` + `PermissionsGuard` so the
 *     controller's `@UseGuards(...)` resolves.
 *   - `ProductsModule` — exposes `ProductsService` for tier-aware
 *     repricing. Mirrors what `SalesModule` does.
 *   - `PromotionsModule` — exposes `POS_EVALUATE_PROMOTIONS_USE_CASE`
 *     via Symbol token. The engine is consumed readonly — we depend on
 *     the I/O contract, not on the engine internals.
 *   - `MailerModule` — exports the `MAILER` injection token so the
 *     send flow can dispatch outbound emails through Resend.
 *   - `PdfGenerationModule` — exports `PdfGenerationService` so the
 *     send flow can render the PDF in-memory.
 *
 * Exports:
 *   - `QuotationsService` — consumed by `PdfGenerationController` for
 *     the `GET /quotations/:id/pdf` route.
 */
import { Module } from '@nestjs/common';

import { QuotationsController } from './controllers/quotations.controller';
import { QuotationsService } from './application/quotations.service';
import { PrismaQuotationRepository } from './infrastructure/prisma-quotation.repository';
import { QUOTATION_REPOSITORY } from './domain/quotation.repository';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { MailerModule } from '../notifications/email/mailer.module';
import { PdfGenerationModule } from '../pdf-generation/pdf-generation.module';

@Module({
  imports: [
    AuthModule,
    ProductsModule,
    PromotionsModule,
    MailerModule,
    PdfGenerationModule,
  ],
  controllers: [QuotationsController],
  providers: [
    QuotationsService,
    {
      provide: QUOTATION_REPOSITORY,
      useClass: PrismaQuotationRepository,
    },
  ],
  exports: [QuotationsService],
})
export class QuotationsModule {}
