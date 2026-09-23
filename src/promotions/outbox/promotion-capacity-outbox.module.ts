/**
 * PromotionCapacityOutboxModule — NestJS module for the pca-3b3b dedicated
 * promotion-capacity outbox dispatch pipeline.
 *
 * Mirrors `HrTimeOffOutboxModule` / `DeliveryRoutesOutboxModule`:
 * separated from `PromotionsModule` so the dep graph (InngestService +
 * Prisma) doesn't pollute transitive module chains that only need
 * promotion CRUD. The module is registered ONLY in `app.module.ts` — the
 * only place where `InngestService` and `PrismaService` are reachable
 * together with the dedicated dispatcher.
 *
 * Provides both the poller and the dispatcher plus every injection token
 * they require: the three poller overrides and the dispatcher's max-retry
 * token. Without the retry token provider Nest cannot construct
 * `PromotionCapacityOutboxDispatcher`.
 *
 * Spec: promotion-capacity-alerts task pca-3b3b. Email delivery,
 * recipients, and config gating remain out of scope (`pca-3b4`).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { InngestModule } from '../../inngest/inngest.module';
import { PromotionCapacityOutboxPoller } from './promotion-capacity-outbox.poller';
import { PromotionCapacityOutboxDispatcher } from './promotion-capacity-outbox.dispatcher';
import {
  PROMOTION_CAPACITY_OUTBOX_POLLER_BATCH_SIZE,
  PROMOTION_CAPACITY_OUTBOX_POLLER_INTERVAL_MS,
  PROMOTION_CAPACITY_OUTBOX_POLLER_LOCK_MS,
} from './promotion-capacity-outbox.poller';
import { PROMOTION_CAPACITY_OUTBOX_DISPATCHER_MAX_RETRIES } from './promotion-capacity-outbox.dispatcher';

@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    ScheduleModule.forRoot(),
    InngestModule,
  ],
  controllers: [],
  providers: [
    PromotionCapacityOutboxPoller,
    PromotionCapacityOutboxDispatcher,
    {
      provide: PROMOTION_CAPACITY_OUTBOX_POLLER_INTERVAL_MS,
      useValue: Number(
        process.env.PROMOTION_CAPACITY_OUTBOX_POLLER_INTERVAL_MS ?? 5000,
      ),
    },
    {
      provide: PROMOTION_CAPACITY_OUTBOX_POLLER_BATCH_SIZE,
      useValue: Number(
        process.env.PROMOTION_CAPACITY_OUTBOX_POLLER_BATCH_SIZE ?? 25,
      ),
    },
    {
      provide: PROMOTION_CAPACITY_OUTBOX_POLLER_LOCK_MS,
      useValue: Number(
        process.env.PROMOTION_CAPACITY_OUTBOX_POLLER_LOCK_MS ?? 60000,
      ),
    },
    {
      provide: PROMOTION_CAPACITY_OUTBOX_DISPATCHER_MAX_RETRIES,
      useValue: Number(
        process.env.PROMOTION_CAPACITY_OUTBOX_DISPATCHER_MAX_RETRIES ?? 5,
      ),
    },
  ],
  exports: [PromotionCapacityOutboxPoller, PromotionCapacityOutboxDispatcher],
})
export class PromotionCapacityOutboxModule {}
