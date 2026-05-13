import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_LOCK_MS,
  OUTBOX_POLL_INTERVAL_MS,
  OutboxPollerService,
} from './outbox-poller.service';
import { OutboxWriterService } from './outbox-writer.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

@Module({
  imports: [EventEmitterModule],
  providers: [
    PrismaService,
    OutboxWriterService,
    OutboxDispatcherService,
    OutboxPollerService,
    {
      provide: OUTBOX_POLL_INTERVAL_MS,
      useValue: Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 5000),
    },
    {
      provide: OUTBOX_BATCH_SIZE,
      useValue: Number(process.env.OUTBOX_BATCH_SIZE ?? 50),
    },
    {
      provide: OUTBOX_LOCK_MS,
      useValue: Number(process.env.OUTBOX_LOCK_MS ?? 30000),
    },
  ],
  exports: [OutboxWriterService],
})
export class OutboxModule {}
