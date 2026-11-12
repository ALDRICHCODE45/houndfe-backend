/**
 * The realtime producer of the notification events (unit 8; contract §5.3,
 * §12.8): writes `notification.created` and `notification.read` into the
 * durable log on the transaction of the change, for the affected person only.
 * The payload holds ids; the notification (title, body, `unreadCount`) is built
 * at delivery time for that person.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { emitRealtimeEvents } from '../../shared/realtime/realtime-event-writes';
import type {
  NotificationCreatedEvent,
  NotificationEventsPort,
  NotificationReadEvent,
  NotificationReadEventsPort,
} from '../domain/notification-events.port';

@Injectable()
export class RealtimeNotificationEvents
  implements NotificationEventsPort, NotificationReadEventsPort
{
  publishCreated(
    tx: Prisma.TransactionClient,
    event: NotificationCreatedEvent,
  ): Promise<void> {
    return emitRealtimeEvents(tx, [
      {
        tenantId: event.tenantId,
        userId: event.userId,
        type: 'notification.created',
        requestId: event.requestId,
        payload: { notificationId: event.notificationId },
      },
    ]);
  }

  publishRead(
    tx: Prisma.TransactionClient,
    event: NotificationReadEvent,
  ): Promise<void> {
    return emitRealtimeEvents(tx, [
      {
        tenantId: event.tenantId,
        userId: event.userId,
        type: 'notification.read',
        payload: { ids: event.ids, all: event.all },
      },
    ]);
  }
}
