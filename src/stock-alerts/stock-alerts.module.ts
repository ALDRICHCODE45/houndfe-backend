/**
 * StockAlertsModule — NestJS module for the stock-alerts bounded context.
 *
 * **Slice F wiring (incremental TDD — F.1–F.5 land in sequence):**
 *
 *   - F.2 (`buildLowStockFunctions` + `LowStockInngestRegistrar`)
 *     registers the low-stock Inngest function with `InngestService`
 *     at module init. The registrar lives in `app.module.ts`
 *     directly to keep the dep graph bounded.
 *   - F.4 (dedicated poller) and F.5 (dedicated dispatcher) providers
 *     are added in their own RED → GREEN slices. Until then the
 *     module stays slim (only the `STOCK_ALERT_STATE_REPOSITORY` and
 *     `USER_EMAIL_LOOKUP` ports) so transitive chains that pull in
 *     StockAlertsModule (SalesModule, ProductsModule, …
 *     ChatbotApiModule's spec) don't break during F.1 + F.2 wiring.
 *
 * Mirrors `src/sat-catalog/sat-catalog.module.ts` and
 * `src/notification-config/notification-config.module.ts`.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaStockAlertStateRepository } from './infrastructure/prisma-stock-alert-state.repository';
import {
  STOCK_ALERT_STATE_REPOSITORY,
} from './domain/stock-alert-state.repository';
import {
  USER_EMAIL_LOOKUP,
} from './domain/user-email-lookup.repository';
import { PrismaUserEmailLookupRepository } from './infrastructure/prisma-user-email-lookup.repository';

@Module({
  imports: [DatabaseModule],
  controllers: [],
  providers: [
    {
      provide: STOCK_ALERT_STATE_REPOSITORY,
      useClass: PrismaStockAlertStateRepository,
    },
    {
      provide: USER_EMAIL_LOOKUP,
      useClass: PrismaUserEmailLookupRepository,
    },
  ],
  exports: [STOCK_ALERT_STATE_REPOSITORY, USER_EMAIL_LOOKUP],
})
export class StockAlertsModule {
  static readonly repository: symbol = STOCK_ALERT_STATE_REPOSITORY;
}
