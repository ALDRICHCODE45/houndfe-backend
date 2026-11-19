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
 *   - `SalesModule` — quotation-sale-conversion / T1: `SalesService` and
 *     `SALE_REPOSITORY` for the POS "Pedido" conversions.
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
import { SalesModule } from '../sales/sales.module';
import { QuotationSaleConversionController } from './controllers/quotation-sale-conversion.controller';
import { QuotationSaleConversionService } from './application/quotation-sale-conversion.service';
import { PrismaQuotationSaleConversionStore } from './infrastructure/prisma-quotation-sale-conversion.store';

@Module({
  imports: [
    AuthModule,
    ProductsModule,
    PromotionsModule,
    MailerModule,
    PdfGenerationModule,
    // quotation-sale-conversion / T1 — `SalesService` (draft sale creation +
    // recompute) and `SALE_REPOSITORY` (lock / delete). No cycle: SalesModule
    // never imports QuotationsModule.
    SalesModule,
  ],
  controllers: [QuotationsController, QuotationSaleConversionController],
  providers: [
    QuotationsService,
    QuotationSaleConversionService,
    PrismaQuotationSaleConversionStore,
    {
      provide: QUOTATION_REPOSITORY,
      useClass: PrismaQuotationRepository,
    },
  ],
  exports: [QuotationsService],
})
export class QuotationsModule {}
