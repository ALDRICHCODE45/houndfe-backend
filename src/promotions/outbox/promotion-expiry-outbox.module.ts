/**
 * PromotionExpiryOutboxModule — NestJS module for the pca-3c3b dedicated
 * promotion-expiry outbox dispatch pipeline.
 *
 * Mirrors `PromotionCapacityOutboxModule`: separated from
 * `PromotionsModule` so the dep graph (InngestService + Prisma) doesn't
 * pollute transitive module chains that only need promotion CRUD.
 *
 * IMPORTANT — this module is deliberately NOT imported by
 * `app.module.ts` in this slice. `pca-3c4c` registers it together with
 * the expiry email function and the scanner, after the dedicated
 * poller/dispatcher and the generic `eventType` exclusion are in place.
 * In the interim the generic fire-and-forget poller excludes
 * `promotion.expiring.detected`, so expiry rows simply stay `PENDING`
 * until activation instead of being published without a durable
 * consumer.
 *
 * Provides both the poller and the dispatcher plus every injection token
 * they require: the three poller overrides and the dispatcher's max-retry
 * token. Without the retry token provider Nest cannot construct
 * `PromotionExpiryOutboxDispatcher`.
 *
 * Spec: promotion-capacity-alerts task pca-3c3b. Email delivery,
 * recipients, and config gating remain out of scope (`pca-3c4b`).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { InngestModule } from '../../inngest/inngest.module';
import { PromotionExpiryOutboxPoller } from './promotion-expiry-outbox.poller';
import { PromotionExpiryOutboxDispatcher } from './promotion-expiry-outbox.dispatcher';
import {
  PROMOTION_EXPIRY_OUTBOX_POLLER_BATCH_SIZE,
  PROMOTION_EXPIRY_OUTBOX_POLLER_INTERVAL_MS,
  PROMOTION_EXPIRY_OUTBOX_POLLER_LOCK_MS,
} from './promotion-expiry-outbox.poller';
import { PROMOTION_EXPIRY_OUTBOX_DISPATCHER_MAX_RETRIES } from './promotion-expiry-outbox.dispatcher';

@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    ScheduleModule.forRoot(),
    InngestModule,
  ],
  controllers: [],
  providers: [
    PromotionExpiryOutboxPoller,
    PromotionExpiryOutboxDispatcher,
    {
      provide: PROMOTION_EXPIRY_OUTBOX_POLLER_INTERVAL_MS,
      useValue: Number(
        process.env.PROMOTION_EXPIRY_OUTBOX_POLLER_INTERVAL_MS ?? 5000,
      ),
    },
    {
      provide: PROMOTION_EXPIRY_OUTBOX_POLLER_BATCH_SIZE,
      useValue: Number(
        process.env.PROMOTION_EXPIRY_OUTBOX_POLLER_BATCH_SIZE ?? 25,
      ),
    },
    {
      provide: PROMOTION_EXPIRY_OUTBOX_POLLER_LOCK_MS,
      useValue: Number(
        process.env.PROMOTION_EXPIRY_OUTBOX_POLLER_LOCK_MS ?? 60000,
      ),
    },
    {
      provide: PROMOTION_EXPIRY_OUTBOX_DISPATCHER_MAX_RETRIES,
      useValue: Number(
        process.env.PROMOTION_EXPIRY_OUTBOX_DISPATCHER_MAX_RETRIES ?? 5,
      ),
    },
  ],
  exports: [PromotionExpiryOutboxPoller, PromotionExpiryOutboxDispatcher],
})
export class PromotionExpiryOutboxModule {}
