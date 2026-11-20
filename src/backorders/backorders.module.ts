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
 * `BACKORDER_RESERVED_HOOK` is the seam T2b binds to `FeedBackorderReservedHook`
 * (`backorder.reserved` + staff notice in the reserving transaction).
 *
 * T5a: `BackordersStaffController` serves the POS staff API (`GET /backorders`,
 * `GET /backorders/:id`, `POST /backorders/:id/cancel`) behind the JWT chain;
 * `AuthModule` supplies its guards.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { HumanDecisionsModule } from '../human-decisions/human-decisions.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductsModule } from '../products/products.module';
import { SalesModule } from '../sales/sales.module';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { TenantModule } from '../shared/tenant/tenant.module';
import { StockAlertsModule } from '../stock-alerts/stock-alerts.module';
import { BackorderAllocator } from './application/backorder-allocator';
import { BackorderReservationService } from './application/backorder-reservation.service';
import { BackordersBotService } from './application/backorders-bot.service';
import { BackordersStaffService } from './application/backorders-staff.service';
import { BACKORDER_RESERVATION_RELEASER } from './application/ports/backorder-reservation-releaser.port';
import { BACKORDER_RESERVED_HOOK } from './application/ports/backorder-reserved-hook.port';
import { BackorderCheckoutService } from './infrastructure/backorder-checkout.service';
import { BackorderCustomerResolver } from './infrastructure/backorder-customer.resolver';
import { BackorderReferencePriceListResolver } from './infrastructure/backorder-reference-price-list.resolver';
import { BackorderReestimateService } from './infrastructure/backorder-reestimate.service';
import { BackorderSweepScheduler } from './infrastructure/backorder-sweep.scheduler';
import { BackorderSweepStore } from './infrastructure/backorder-sweep.store';
import { BackorderStockReader } from './infrastructure/backorder-stock.reader';
import { FeedBackorderReservedHook } from './infrastructure/feed-backorder-reserved.hook';
import { BackordersBotController } from './presentation/backorders-bot.controller';
import { BackordersStaffController } from './presentation/backorders-staff.controller';

@Module({
  imports: [
    DatabaseModule,
    // T5a: `JwtAuthGuard`, `CaslAbilityFactory` and `PermissionsGuard` of the staff routes.
    AuthModule,
    ChatbotApiModule,
    ProductsModule,
    SalesModule,
    InventoryModule,
    // T4: the RESTOCK intake (server-created re-estimate) and the resolution registry.
    HumanDecisionsModule,
    StockAlertsModule,
    TenantModule,
  ],
  controllers: [BackordersBotController, BackordersStaffController],
  providers: [
    BackordersBotService,
    // T5a: staff list / detail / cancel (POS).
    BackordersStaffService,
    BackorderCustomerResolver,
    BackorderStockReader,
    BackorderReferencePriceListResolver,
    BackorderAllocator,
    BackorderReservationService,
    // T4: overdue-ETA re-estimate (one RESTOCK decision per product) + its
    // fan-out on the staff resolution (registers itself).
    BackorderReestimateService,
    // T2b: reminder, expiry, expired-lot swap and the safety-net allocation.
    BackorderSweepStore,
    BackorderSweepScheduler,
    // T3: confirm a reserved backorder through the bot checkout (registers itself).
    BackorderCheckoutService,
    // T2a: the real releaser (BACKORDER_RELEASE + next in queue).
    {
      provide: BACKORDER_RESERVATION_RELEASER,
      useExisting: BackorderReservationService,
    },
    // T2b: `backorder.reserved` + the staff notice, in the reserving transaction.
    { provide: BACKORDER_RESERVED_HOOK, useClass: FeedBackorderReservedHook },
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
