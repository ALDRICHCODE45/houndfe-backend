/**
 * DeliveryRoutesOutboxModule — delivery-routes / WU3 (design §5).
 *
 * NestJS module for the dedicated delivery-routes outbox dispatch
 * pipeline. Mirrors `LowStockOutboxModule` / `HrTimeOffOutboxModule`:
 * separated from `DeliveryRoutesModule` so the dep graph (Inngest +
 * Prisma) doesn't pollute transitive chains that don't need to send
 * emails (e.g. future chat APIs that consume route read-models).
 *
 * Registered ONLY in `app.module.ts` — the only place where
 * `InngestService` and `PrismaService` are reachable together with
 * the dedicated dispatcher.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { InngestModule } from '../../inngest/inngest.module';
import { DeliveryRoutesOutboxPoller } from './delivery-routes-outbox.poller';
import { DeliveryRoutesOutboxDispatcher } from './delivery-routes-outbox.dispatcher';
import {
  DELIVERY_ROUTES_OUTBOX_POLLER_BATCH_SIZE,
  DELIVERY_ROUTES_OUTBOX_POLLER_INTERVAL_MS,
  DELIVERY_ROUTES_OUTBOX_POLLER_LOCK_MS,
} from './delivery-routes-outbox.poller';
import { DELIVERY_ROUTES_OUTBOX_DISPATCHER_MAX_RETRIES } from './delivery-routes-outbox.dispatcher';

@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    ScheduleModule.forRoot(),
    InngestModule,
  ],
  controllers: [],
  providers: [
    DeliveryRoutesOutboxPoller,
    DeliveryRoutesOutboxDispatcher,
    {
      provide: DELIVERY_ROUTES_OUTBOX_POLLER_INTERVAL_MS,
      useValue: Number(
        process.env.DELIVERY_ROUTES_OUTBOX_POLLER_INTERVAL_MS ?? 5000,
      ),
    },
    {
      provide: DELIVERY_ROUTES_OUTBOX_POLLER_BATCH_SIZE,
      useValue: Number(
        process.env.DELIVERY_ROUTES_OUTBOX_POLLER_BATCH_SIZE ?? 25,
      ),
    },
    {
      provide: DELIVERY_ROUTES_OUTBOX_POLLER_LOCK_MS,
      useValue: Number(
        process.env.DELIVERY_ROUTES_OUTBOX_POLLER_LOCK_MS ?? 60000,
      ),
    },
    {
      provide: DELIVERY_ROUTES_OUTBOX_DISPATCHER_MAX_RETRIES,
      useValue: Number(
        process.env.DELIVERY_ROUTES_OUTBOX_DISPATCHER_MAX_RETRIES ?? 5,
      ),
    },
  ],
  exports: [DeliveryRoutesOutboxPoller, DeliveryRoutesOutboxDispatcher],
})
export class DeliveryRoutesOutboxModule {}
