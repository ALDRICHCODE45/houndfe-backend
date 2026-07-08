/**
 * LowStockOutboxModule — NestJS module for the dedicated F.4 + F.5
 * low-stock outbox dispatch pipeline.
 *
 * Separated from `StockAlertsModule` so it doesn't get pulled into
 * every transitive chain (SalesModule → ProductsModule →
 * StockAlertsModule is reached by ChatbotApiModule's spec, which
 * does not import InngestModule / ResendMailer / etc. Including
 * the dispatcher there would break the spec's
 * `Test.createTestingModule({ imports: [ChatbotApiModule] })`).
 *
 * The module is registered ONLY in `app.module.ts` — the only
 * place where all of `InngestService`, `ResendMailer`, and
 * `TenantRunnerService` are reachable together.
 *
 * Spec: design.md "Durable dispatch flow (finding #10)" + Slice
 * F.4 + F.5 task in `tasks.md`.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { TenantModule } from '../../shared/tenant/tenant.module';
import { InngestModule } from '../../inngest/inngest.module';
import { LowStockOutboxPoller } from './low-stock-outbox.poller';
import { LowStockOutboxDispatcher } from './low-stock-outbox.dispatcher';
import {
  LOW_STOCK_OUTBOX_POLLER_BATCH_SIZE,
  LOW_STOCK_OUTBOX_POLLER_INTERVAL_MS,
  LOW_STOCK_OUTBOX_POLLER_LOCK_MS,
} from './low-stock-outbox.poller';
import { LOW_STOCK_OUTBOX_DISPATCHER_MAX_RETRIES } from './low-stock-outbox.dispatcher';

@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    ScheduleModule.forRoot(),
    TenantModule,
    InngestModule,
  ],
  controllers: [],
  providers: [
    LowStockOutboxPoller,
    LowStockOutboxDispatcher,
    {
      provide: LOW_STOCK_OUTBOX_POLLER_INTERVAL_MS,
      useValue: Number(process.env.LOW_STOCK_OUTBOX_POLLER_INTERVAL_MS ?? 5000),
    },
    {
      provide: LOW_STOCK_OUTBOX_POLLER_BATCH_SIZE,
      useValue: Number(process.env.LOW_STOCK_OUTBOX_POLLER_BATCH_SIZE ?? 25),
    },
    {
      provide: LOW_STOCK_OUTBOX_POLLER_LOCK_MS,
      useValue: Number(process.env.LOW_STOCK_OUTBOX_POLLER_LOCK_MS ?? 60000),
    },
    {
      provide: LOW_STOCK_OUTBOX_DISPATCHER_MAX_RETRIES,
      useValue: Number(
        process.env.LOW_STOCK_OUTBOX_DISPATCHER_MAX_RETRIES ?? 5,
      ),
    },
  ],
  exports: [LowStockOutboxPoller, LowStockOutboxDispatcher],
})
export class LowStockOutboxModule {}
