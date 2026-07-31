/**
 * QuotationsModule — NestJS module for the Quotations bounded context.
 *
 * WU2 — wiring only. WU3 wires the engine port (`POS_EVALUATE_PROMOTIONS_USE_CASE`)
 * + `PromotionsModule`. WU4 adds the `PdfGenerationModule` import. This
 * module intentionally stays slim today (mirrors the WU2 rule-of-three
 * deferral on the recompute pipeline — see T021).
 *
 * Provider bindings:
 *   - `QuotationsService`              — use-case orchestrator.
 *   - `{ QUOTATION_REPOSITORY → PrismaQuotationRepository }` — persistence port.
 *
 * Imports:
 *   - `AuthModule` — provides `JwtAuthGuard` + `PermissionsGuard` so the
 *     controller's `@UseGuards(...)` resolves.
 *
 * The catalog lookup (`customer.globalPriceListId`, `globalPriceList.findUnique`)
 * goes through `TenantPrismaService` which is provided globally by
 * `DatabaseModule`. No dedicated customer/price-list module import is
 * needed at this layer (read pattern matches `SalesService`).
 *
 * Exports:
 *   - `QuotationsService` — needed by `PdfGenerationModule` in WU4 to
 *     wire `renderQuotationPdf`. WU2 declares the export now to avoid
 *     a WU4 wiring churn.
 */
import { Module } from '@nestjs/common';

import { QuotationsController } from './controllers/quotations.controller';
import { QuotationsService } from './application/quotations.service';
import { PrismaQuotationRepository } from './infrastructure/prisma-quotation.repository';
import { QUOTATION_REPOSITORY } from './domain/quotation.repository';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
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
