/**
 * shipping-zones / T1 (S3) — dedicated outbox poller/dispatcher for
 * `delivery_zone.validation.requested` rows. Mirrors HrTimeOffOutboxModule;
 * the generic poller excludes this eventType so exactly one poller owns it.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { InngestModule } from '../../inngest/inngest.module';
import { DeliveryZoneOutboxPoller } from './delivery-zone-outbox.poller';
import { DeliveryZoneOutboxDispatcher } from './delivery-zone-outbox.dispatcher';
import {
  DELIVERY_ZONE_OUTBOX_POLLER_BATCH_SIZE,
  DELIVERY_ZONE_OUTBOX_POLLER_INTERVAL_MS,
  DELIVERY_ZONE_OUTBOX_POLLER_LOCK_MS,
} from './delivery-zone-outbox.poller';
import { DELIVERY_ZONE_OUTBOX_DISPATCHER_MAX_RETRIES } from './delivery-zone-outbox.dispatcher';

@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    ScheduleModule.forRoot(),
    InngestModule,
  ],
  controllers: [],
  providers: [
    DeliveryZoneOutboxPoller,
    DeliveryZoneOutboxDispatcher,
    {
      provide: DELIVERY_ZONE_OUTBOX_POLLER_INTERVAL_MS,
      useValue: Number(
        process.env.DELIVERY_ZONE_OUTBOX_POLLER_INTERVAL_MS ?? 5000,
      ),
    },
    {
      provide: DELIVERY_ZONE_OUTBOX_POLLER_BATCH_SIZE,
      useValue: Number(
        process.env.DELIVERY_ZONE_OUTBOX_POLLER_BATCH_SIZE ?? 25,
      ),
    },
    {
      provide: DELIVERY_ZONE_OUTBOX_POLLER_LOCK_MS,
      useValue: Number(
        process.env.DELIVERY_ZONE_OUTBOX_POLLER_LOCK_MS ?? 60000,
      ),
    },
    {
      provide: DELIVERY_ZONE_OUTBOX_DISPATCHER_MAX_RETRIES,
      useValue: Number(
        process.env.DELIVERY_ZONE_OUTBOX_DISPATCHER_MAX_RETRIES ?? 5,
      ),
    },
  ],
  exports: [DeliveryZoneOutboxPoller, DeliveryZoneOutboxDispatcher],
})
export class DeliveryZoneOutboxModule {}
