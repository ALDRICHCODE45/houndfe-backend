/**
 * ReceiptReviewOutboxModule — durable pipeline for the RECEIPT_REVIEW_REQUESTED
 * staff email (poller + dispatcher). Mirrors HrTimeOffOutboxModule and is
 * registered only in app.module.ts, where InngestService is reachable.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { InngestModule } from '../../inngest/inngest.module';
import { ReceiptReviewOutboxPoller } from './receipt-review-outbox.poller';
import { ReceiptReviewOutboxDispatcher } from './receipt-review-outbox.dispatcher';
import {
  RECEIPT_REVIEW_OUTBOX_POLLER_BATCH_SIZE,
  RECEIPT_REVIEW_OUTBOX_POLLER_INTERVAL_MS,
  RECEIPT_REVIEW_OUTBOX_POLLER_LOCK_MS,
} from './receipt-review-outbox.poller';
import { RECEIPT_REVIEW_OUTBOX_DISPATCHER_MAX_RETRIES } from './receipt-review-outbox.dispatcher';

@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    ScheduleModule.forRoot(),
    InngestModule,
  ],
  controllers: [],
  providers: [
    ReceiptReviewOutboxPoller,
    ReceiptReviewOutboxDispatcher,
    {
      provide: RECEIPT_REVIEW_OUTBOX_POLLER_INTERVAL_MS,
      useValue: Number(
        process.env.RECEIPT_REVIEW_OUTBOX_POLLER_INTERVAL_MS ?? 5000,
      ),
    },
    {
      provide: RECEIPT_REVIEW_OUTBOX_POLLER_BATCH_SIZE,
      useValue: Number(
        process.env.RECEIPT_REVIEW_OUTBOX_POLLER_BATCH_SIZE ?? 25,
      ),
    },
    {
      provide: RECEIPT_REVIEW_OUTBOX_POLLER_LOCK_MS,
      useValue: Number(
        process.env.RECEIPT_REVIEW_OUTBOX_POLLER_LOCK_MS ?? 60000,
      ),
    },
    {
      provide: RECEIPT_REVIEW_OUTBOX_DISPATCHER_MAX_RETRIES,
      useValue: Number(
        process.env.RECEIPT_REVIEW_OUTBOX_DISPATCHER_MAX_RETRIES ?? 5,
      ),
    },
  ],
  exports: [ReceiptReviewOutboxPoller, ReceiptReviewOutboxDispatcher],
})
export class ReceiptReviewOutboxModule {}
