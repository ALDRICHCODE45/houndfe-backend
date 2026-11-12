/**
 * Hook where `notification.created` is published (contract §5.3). It receives
 * the consumer's transaction on purpose: the realtime adapter
 * (`RealtimeNotificationEvents`, unit 8) inserts the durable `realtime_events`
 * row and the `NOTIFY` in the same commit as the notification, so a crash can
 * never lose the event. `noopNotificationEvents` stays for specs and for
 * modules that do not serve the stream.
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
  /**
   * Every recipient of one notice in one call (one lock and one `NOTIFY` for
   * the batch). Optional: adapters without it get one `publishCreated` each.
   */
  publishCreatedMany?(
    tx: Prisma.TransactionClient,
    events: readonly NotificationCreatedEvent[],
  ): Promise<void>;
}

export const NOTIFICATION_EVENTS = Symbol.for('NotificationEvents');

/**
 * `notification.read` (contract §5.2, §12.8): the person marked one notice
 * (`ids`) or all of theirs (`all`) as read, so their other tabs and devices
 * update. Receives the update's own transaction, like `publishCreated`.
 */
export interface NotificationReadEvent {
  tenantId: string;
  userId: string;
  ids: string[] | null;
  all: boolean;
}

export interface NotificationReadEventsPort {
  publishRead(
    tx: Prisma.TransactionClient,
    event: NotificationReadEvent,
  ): Promise<void>;
}

export const NOTIFICATION_READ_EVENTS = Symbol.for('NotificationReadEvents');

export const noopNotificationEvents: NotificationEventsPort = {
  publishCreated: () => Promise.resolve(),
};
