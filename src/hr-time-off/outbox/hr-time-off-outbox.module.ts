/**
 * HrTimeOffOutboxModule — NestJS module for the Slice 5 dedicated
 * HR-time-off outbox dispatch pipeline.
 *
 * Mirrors `LowStockOutboxModule`: separated so the dep graph
 * (InngestService + Mailer + TenantRunner) doesn't pollute transitive
 * module chains. The module is registered ONLY in `app.module.ts` —
 * the only place where `InngestService`, `TenantRunnerService`, and
 * the mailer port are reachable together.
 *
 * Spec: design.md D5 — reuse tokens. No new adapters are introduced.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { InngestModule } from '../../inngest/inngest.module';
import { HrTimeOffOutboxPoller } from './hr-time-off-outbox.poller';
import { HrTimeOffOutboxDispatcher } from './hr-time-off-outbox.dispatcher';
import {
  HR_TIME_OFF_OUTBOX_POLLER_BATCH_SIZE,
  HR_TIME_OFF_OUTBOX_POLLER_INTERVAL_MS,
  HR_TIME_OFF_OUTBOX_POLLER_LOCK_MS,
} from './hr-time-off-outbox.poller';
import { HR_TIME_OFF_OUTBOX_DISPATCHER_MAX_RETRIES } from './hr-time-off-outbox.dispatcher';

@Module({
  imports: [DatabaseModule, ConfigModule, ScheduleModule.forRoot(), InngestModule],
  controllers: [],
  providers: [
    HrTimeOffOutboxPoller,
    HrTimeOffOutboxDispatcher,
    {
      provide: HR_TIME_OFF_OUTBOX_POLLER_INTERVAL_MS,
      useValue: Number(
        process.env.HR_TIME_OFF_OUTBOX_POLLER_INTERVAL_MS ?? 5000,
      ),
    },
    {
      provide: HR_TIME_OFF_OUTBOX_POLLER_BATCH_SIZE,
      useValue: Number(process.env.HR_TIME_OFF_OUTBOX_POLLER_BATCH_SIZE ?? 25),
    },
    {
      provide: HR_TIME_OFF_OUTBOX_POLLER_LOCK_MS,
      useValue: Number(process.env.HR_TIME_OFF_OUTBOX_POLLER_LOCK_MS ?? 60000),
    },
    {
      provide: HR_TIME_OFF_OUTBOX_DISPATCHER_MAX_RETRIES,
      useValue: Number(
        process.env.HR_TIME_OFF_OUTBOX_DISPATCHER_MAX_RETRIES ?? 5,
      ),
    },
  ],
  exports: [HrTimeOffOutboxPoller, HrTimeOffOutboxDispatcher],
})
export class HrTimeOffOutboxModule {}