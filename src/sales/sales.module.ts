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
import { ChatbotRequestWrapperModule } from '../chatbot-requests/chatbot-request-wrapper.module';
import { CashRegisterModule } from '../cash-register/cash-register.module';
import { SalesController } from './sales.controller';
import { SalesCatalogController } from './sales-catalog.controller';
import { SALES_CLOCK, SalesService } from './sales.service';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import { SALE_REPOSITORY } from './domain/sale.repository';
import { ProductsModule } from '../products/products.module';
import { InventoryModule } from '../inventory/inventory.module';
import { StockAlertsModule } from '../stock-alerts/stock-alerts.module';
import { SaleStockService } from './sale-stock.service';
import { AuthModule } from '../auth/auth.module';
import { SaleEventListener } from './listeners/sale-event.listener';
import { SalesQueryController } from './sales-query.controller';
import { SalesCustomerMonthlyController } from './sales-customer-monthly.controller';
import { CustomerStatementService } from './customer-statement.service';
import { CUSTOMER_STATEMENT_READER } from './domain/customer-statement.reader';
import { PrismaCustomerStatementReader } from './infrastructure/prisma-customer-statement.reader';
import { SalesPaymentsController } from './sales-payments.controller';
import { SaleHoldController } from './sale-hold.controller';
import { SaleHoldService } from './sale-hold.service';
import { SaleHoldExpireService } from './sale-hold-expire.service';
import { SaleHoldSweepScheduler } from './sale-hold-sweep.scheduler';
import { SaleHoldSweepStore } from './sale-hold-sweep.store';
import { TenantModule } from '../shared/tenant/tenant.module';
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
    ChatbotRequestWrapperModule,
    TenantModule,
  ],
  controllers: [
    SalesController,
    SalesCatalogController,
    SalesQueryController,
    SalesPaymentsController,
    // pay-in-store-pickup / T1 — PATCH /sales/:id/hold.
    SaleHoldController,
    ReceiptReviewController,
    // sales-history-redesign S4 — GET /customers/:customerId/sales-monthly.
    SalesCustomerMonthlyController,
  ],
  providers: [
    SalesService,
    // sales-history-redesign — overdue cut-off / current month clock.
    { provide: SALES_CLOCK, useValue: () => new Date() },
    // sales-history-redesign S11 — customer statement data. The PDF route
    // (`SalesCustomerStatementController`) is registered in
    // PdfGenerationModule, which already imports this module.
    CustomerStatementService,
    {
      provide: CUSTOMER_STATEMENT_READER,
      useClass: PrismaCustomerStatementReader,
    },
    SaleHoldService,
    // pay-in-store-pickup / T2 — reminder and expiry sweep of the holds.
    SaleHoldSweepStore,
    SaleHoldSweepScheduler,
    SaleHoldExpireService,
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
  exports: [
    SalesService,
    SALE_REPOSITORY,
    ReceiptReviewService,
    SaleHoldService,
    CustomerStatementService,
  ],
})
export class SalesModule {}
