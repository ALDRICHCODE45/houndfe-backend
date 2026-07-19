/**
 * SalesModule - NestJS module for the Sales bounded context (POS).
 *
 * Registers:
 * - PrismaSaleRepository as ISaleRepository adapter
 * - SalesService for use case orchestration
 * - SalesController for HTTP endpoints
 *
 * Depends on ProductsModule for product/variant validation and stock checks.
 */
import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesCatalogController } from './sales-catalog.controller';
import { SalesService } from './sales.service';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import { SALE_REPOSITORY } from './domain/sale.repository';
import { ProductsModule } from '../products/products.module';
import { AuthModule } from '../auth/auth.module';
import { SaleEventListener } from './listeners/sale-event.listener';
import { SalesQueryController } from './sales-query.controller';
import { SalesPaymentsController } from './sales-payments.controller';
import { OutboxModule } from '../shared/outbox/outbox.module';
import { SaleCommentsModule } from './comments/sale-comments.module';
import { ReceiptReviewController } from './review/receipt-review.controller';
import { ReceiptReviewService } from './review/receipt-review.service';
import { RECEIPT_REVIEW_REPOSITORY } from './review/domain/receipt-review.repository';
import { PrismaReceiptReviewRepository } from './review/infrastructure/prisma-receipt-review.repository';
// Work Unit 4 — SalesModule depends on the POS promotion engine (via Symbol
// port) so SalesService can call `recomputePricingAndPromotions(sale)` after each
// draft mutation. Hexagonal: we import the module to resolve the symbol,
// but we depend on the I/O contract, not on the engine internals.
import { PromotionsModule } from '../promotions/promotions.module';

@Module({
  imports: [
    ProductsModule,
    AuthModule,
    OutboxModule,
    SaleCommentsModule,
    PromotionsModule,
  ],
  controllers: [
    SalesController,
    SalesCatalogController,
    SalesQueryController,
    SalesPaymentsController,
    ReceiptReviewController,
  ],
  providers: [
    SalesService,
    {
      provide: SALE_REPOSITORY,
      useClass: PrismaSaleRepository,
    },
    ReceiptReviewService,
    {
      provide: RECEIPT_REVIEW_REPOSITORY,
      useClass: PrismaReceiptReviewRepository,
    },
    SaleEventListener,
  ],
  exports: [SalesService],
})
export class SalesModule {}
