/**
 * SalesModule - NestJS module for the Sales bounded context (POS).
 *
 * Registers:
 * - PrismaSaleRepository as ISaleRepository adapter
 * - SalesService for use case orchestration
 * - SalesController for HTTP endpoints
 *
 * Depends on ProductsModule for product/variant validation and stock checks,
 * and on InventoryModule (stock journal) for the charge/cancel stock writes.
 */
import { Module } from '@nestjs/common';
import { CashRegisterModule } from '../cash-register/cash-register.module';
import { SalesController } from './sales.controller';
import { SalesCatalogController } from './sales-catalog.controller';
import { SalesService } from './sales.service';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import { SALE_REPOSITORY } from './domain/sale.repository';
import { ProductsModule } from '../products/products.module';
import { InventoryModule } from '../inventory/inventory.module';
import { StockAlertsModule } from '../stock-alerts/stock-alerts.module';
import { SaleStockService } from './sale-stock.service';
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
// Custom Payment Methods (custom-payment-methods / WU2 / D3) —
// SalesModule imports the catalog module to resolve the
// `PAYMENT_METHOD_RESOLVER` symbol. Mirrors the PromotionsModule
// Symbol-port seam; sales never depends on the catalog repository
// port directly.
import { AdminPaymentMethodModule } from '../admin/payment-methods/admin-payment-method.module';

@Module({
  imports: [
    ProductsModule,
    InventoryModule,
    StockAlertsModule,
    AuthModule,
    OutboxModule,
    SaleCommentsModule,
    PromotionsModule,
    AdminPaymentMethodModule,
    CashRegisterModule,
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
    SaleStockService,
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
  exports: [SalesService, SALE_REPOSITORY],
})
export class SalesModule {}
