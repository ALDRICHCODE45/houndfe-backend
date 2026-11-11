/**
 * Hook where `notification.created` is published (contract §5.3). The SSE
 * stream is unit 8; until then the default is a no-op. It receives the
 * consumer's transaction on purpose: unit 8 can insert its durable
 * `RealtimeEvent` row (and `NOTIFY`) in the same commit as the notification,
 * so a crash can never lose the event.
 */
import type { Prisma } from '@prisma/client';

export interface NotificationCreatedEvent {
  tenantId: string;
  userId: string;
  notificationId: string;
  type: string;
  requestId: string | null;
}

export interface NotificationEventsPort {
  publishCreated(
    tx: Prisma.TransactionClient,
    event: NotificationCreatedEvent,
  ): Promise<void>;
}

export const NOTIFICATION_EVENTS = Symbol.for('NotificationEvents');

export const noopNotificationEvents: NotificationEventsPort = {
  publishCreated: () => Promise.resolve(),
};
