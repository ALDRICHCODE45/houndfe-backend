/**
 * StockAlertsModule — NestJS module for the stock-alerts bounded context.
 *
 * Slice E.2 wiring: registers the `StockAlertState` atomic-flip port
 * (`STOCK_ALERT_STATE_REPOSITORY`) and binds the Prisma adapter. The
 * module is consumed by `ProductsModule` (the product repository
 * depends on the flip machine for in-tx edge-trigger detection).
 *
 * Slice F (NOT implemented here) will register `LowStockOutboxPoller`,
 * `LowStockOutboxDispatcher`, and Inngest function builders — they
 * ride on top of the durable outbox rows this slice writes in-tx.
 *
 * Mirrors `src/sat-catalog/sat-catalog.module.ts` and
 * `src/notification-config/notification-config.module.ts`.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaStockAlertStateRepository } from './infrastructure/prisma-stock-alert-state.repository';
import {
  STOCK_ALERT_STATE_REPOSITORY,
  type IStockAlertStateRepository,
} from './domain/stock-alert-state.repository';

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: STOCK_ALERT_STATE_REPOSITORY,
      useClass: PrismaStockAlertStateRepository,
    },
  ],
  exports: [STOCK_ALERT_STATE_REPOSITORY],
})
export class StockAlertsModule {
  // Re-export the interface type for consumers that want the union
  // without importing from the adapter file.
  static readonly repository: symbol = STOCK_ALERT_STATE_REPOSITORY;
}

// Re-export so callers can `import { StockAlertsModule }` without
// pulling in the symbol token accidentally.
export type { IStockAlertStateRepository };