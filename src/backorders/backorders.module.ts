/**
 * Restock backorders («pedido por reposición», contract v1). T1: the model, the
 * per-tenant folio and the bot routes `POST/GET/list/cancel
 * /chatbot-api/backorders`.
 *
 * `ChatbotApiModule` supplies the bot guard and its credential repository;
 * `SalesModule` supplies `SalesService.previewBotPricing` (the same price
 * resolution the bot checkout uses); `ProductsModule` supplies the price-list
 * lookup that tells whether the customer's list or PUBLICO priced the line. `DatabaseModule` and `ConfigModule` are
 * global providers (`TenantPrismaService`, `ConfigService`).
 *
 * T2a: `BackorderAllocator` subscribes itself to the stock journal writer
 * (`InventoryModule`) and runs in the same transaction after every stock
 * increase; `BACKORDER_RESERVATION_RELEASER` is bound to
 * `BackorderReservationService` (BACKORDER_RELEASE + next in queue) and
 * `BACKORDER_RESERVED_HOOK` is the no-op seam T2b rebinds to enqueue the feed.
 */
import { Module } from '@nestjs/common';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductsModule } from '../products/products.module';
import { SalesModule } from '../sales/sales.module';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { StockAlertsModule } from '../stock-alerts/stock-alerts.module';
import { BackorderAllocator } from './application/backorder-allocator';
import { BackorderReservationService } from './application/backorder-reservation.service';
import { BackordersBotService } from './application/backorders-bot.service';
import { BACKORDER_RESERVATION_RELEASER } from './application/ports/backorder-reservation-releaser.port';
import { BACKORDER_RESERVED_HOOK } from './application/ports/backorder-reserved-hook.port';
import { BackorderCustomerResolver } from './infrastructure/backorder-customer.resolver';
import { BackorderReferencePriceListResolver } from './infrastructure/backorder-reference-price-list.resolver';
import { BackorderStockReader } from './infrastructure/backorder-stock.reader';
import { NoOpBackorderReservedHook } from './infrastructure/no-op-backorder-reserved.hook';
import { BackordersBotController } from './presentation/backorders-bot.controller';

@Module({
  imports: [
    DatabaseModule,
    ChatbotApiModule,
    ProductsModule,
    SalesModule,
    InventoryModule,
    StockAlertsModule,
  ],
  controllers: [BackordersBotController],
  providers: [
    BackordersBotService,
    BackorderCustomerResolver,
    BackorderStockReader,
    BackorderReferencePriceListResolver,
    BackorderAllocator,
    BackorderReservationService,
    // T2a: the real releaser (BACKORDER_RELEASE + next in queue).
    {
      provide: BACKORDER_RESERVATION_RELEASER,
      useExisting: BackorderReservationService,
    },
    // T2b rebinds this to enqueue the `backorder.reserved` feed item.
    { provide: BACKORDER_RESERVED_HOOK, useClass: NoOpBackorderReservedHook },
  ],
  exports: [
    BackordersBotService,
    BackorderAllocator,
    BackorderReservationService,
    BACKORDER_RESERVATION_RELEASER,
    BACKORDER_RESERVED_HOOK,
  ],
})
export class BackordersModule {}
