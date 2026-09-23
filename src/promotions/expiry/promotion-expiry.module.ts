/**
 * PromotionExpiryModule — pca-3c2.
 *
 * NestJS module for the bounded promotion-expiration scanner. It wires the
 * scanner to the committed tenant-qualified claim adapter through the
 * `PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY` token and provides the two
 * engineering-only override tokens (interval, batch cap).
 *
 * WHY IT IS DELIBERATELY NOT REGISTERED IN `AppModule` YET
 * -------------------------------------------------------
 * Registering the scanner would start publishing `promotion.expiring.detected`
 * outbox rows. Until the dedicated expiry poller plus its exclusion from the
 * generic fire-and-forget poller exist (`pca-3c3b`), and the dispatcher
 * (`pca-3c3a`) and the email function (`pca-3c4b`) are in place, the generic
 * poller would consume those rows without durable dispatch or delivery. The
 * module therefore compiles and is exported, but stays inert: `pca-3c4c` adds
 * it to `AppModule` together with the complete delivery path and its wiring
 * proof.
 *
 * Mirrors `PromotionCapacityOutboxModule`: separated from `PromotionsModule` so
 * the scanner's dep graph (Prisma + outbox writer) never leaks into module
 * chains that only need promotion CRUD. `OutboxWriterService` is provided
 * directly instead of importing `OutboxModule`: the writer is a stateless
 * injectable with no constructor dependencies, and importing `OutboxModule`
 * would drag in the generic outbox poller/dispatcher and the event bus this
 * inert module neither needs nor should activate.
 *
 * Spec: promotion-capacity-alerts task pca-3c2.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import { PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY } from '../domain/promotion-expiry-alert-state.repository';
import { PrismaPromotionExpiryAlertStateRepository } from '../infrastructure/prisma-promotion-expiry-alert-state.repository';
import {
  PROMOTION_EXPIRY_SCANNER_BATCH_SIZE,
  PROMOTION_EXPIRY_SCANNER_INTERVAL_MS,
  PromotionExpiryScanner,
} from './promotion-expiry.scanner';

@Module({
  imports: [DatabaseModule, ConfigModule, ScheduleModule.forRoot()],
  providers: [
    PromotionExpiryScanner,
    OutboxWriterService,
    {
      provide: PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY,
      useClass: PrismaPromotionExpiryAlertStateRepository,
    },
    {
      provide: PROMOTION_EXPIRY_SCANNER_INTERVAL_MS,
      useValue: Number(
        process.env.PROMOTION_EXPIRY_SCANNER_INTERVAL_MS ?? 5 * 60 * 1000,
      ),
    },
    {
      provide: PROMOTION_EXPIRY_SCANNER_BATCH_SIZE,
      useValue: Number(process.env.PROMOTION_EXPIRY_SCANNER_BATCH_SIZE ?? 25),
    },
  ],
  exports: [PromotionExpiryScanner],
})
export class PromotionExpiryModule {}
