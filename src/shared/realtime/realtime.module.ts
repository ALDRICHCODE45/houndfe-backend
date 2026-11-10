/**
 * Shared realtime infrastructure (R7): the per-replica LISTEN connection. The
 * bot feed wakes its long-polls through it; the SSE stream (unit 8) will share
 * the same instance.
 */
import { Module } from '@nestjs/common';
import { PgNotificationListener } from './pg-notification-listener';

@Module({
  providers: [PgNotificationListener],
  exports: [PgNotificationListener],
})
export class RealtimeModule {}
