/**
 * Builds the payload of each stream event for ONE recipient (unit 8; contract
 * §12.8, R12). `prepare` runs once per batch inside the tenant's CLS scope and
 * loads what every recipient of the batch shares (the request rows, their
 * customers, the SLA policy, notification views); `shape` is then pure CPU per
 * recipient: the row is built with THEIR ability (`allowedActions`,
 * `toStaffPhone`) and the keys sealed with `CustomerKeySealer`, and a row the
 * recipient cannot read is never produced.
 *
 *   request.*             {request, customer, previousCustomerKey}
 *   notification.created  {notification, unreadCount}
 *   notification.read     {ids, all, unreadCount}
 *
 * The rows are the CURRENT state at delivery time (not a snapshot taken when
 * the event was logged), so a request that changed twice sends its latest
 * version both times; clients only apply a row whose `version` is higher.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ChatbotRequestReadsService,
  type EventRowsBatch,
} from '../../chatbot-requests/application/chatbot-request-reads.service';
import type { PermissionCheck } from '../../chatbot-requests/domain/resolve-permissions';
import type { NotificationView } from '../../notifications/application/notifications.service';
import { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import {
  isNotificationStreamType,
  isRequestStreamType,
  type SseFrame,
} from '../domain/realtime-events';
import type { RealtimeEventRow } from '../infrastructure/prisma-realtime-event.store';
import {
  REALTIME_NOTIFICATION_READER,
  type NotificationEventReader,
} from './notification-event-reader';
import type { HubShaper } from './realtime-hub.service';

export interface PreparedBatch {
  tenantId: string;
  rows: EventRowsBatch;
  /** event id -> the notice and its owner's unread count. */
  created: Map<bigint, { notification: NotificationView; unreadCount: number }>;
  /** user id -> unread count, for `notification.read`. */
  unread: Map<string, number>;
}

@Injectable()
export class RealtimeEventShaper implements HubShaper {
  constructor(
    private readonly tenants: TenantRunnerService,
    private readonly reads: ChatbotRequestReadsService,
    @Inject(REALTIME_NOTIFICATION_READER)
    private readonly notifications: NotificationEventReader,
  ) {}

  prepare(
    tenantId: string,
    events: RealtimeEventRow[],
    audience: ReadonlySet<string>,
  ): Promise<PreparedBatch> {
    const requestIds = events
      .filter((e) => isRequestStreamType(e.type) && e.requestId)
      .map((e) => e.requestId as string);
    // Notification events are personal: only people with a stream on THIS
    // replica can receive a frame, so nobody else costs a query. The rest of
    // the batch is read in one query for the notices and one for the counts.
    const wanted: Array<{ userId: string; id: string }> = [];
    const countUsers = new Set<string>();
    for (const event of events) {
      if (!event.userId || !audience.has(event.userId)) continue;
      if (event.type === 'notification.created') {
        const id = event.payload.notificationId;
        if (typeof id !== 'string') continue;
        wanted.push({ userId: event.userId, id });
        countUsers.add(event.userId);
      } else if (event.type === 'notification.read') {
        countUsers.add(event.userId);
      }
    }
    return this.tenants.runWithTenant(tenantId, async () => {
      const [rows, views, counts] = await Promise.all([
        this.reads.loadEventRows(requestIds),
        wanted.length > 0
          ? this.notifications.views(wanted)
          : Promise.resolve(new Map<string, NotificationView>()),
        countUsers.size > 0
          ? this.notifications.unreadCounts([...countUsers])
          : Promise.resolve(new Map<string, number>()),
      ]);
      const created: PreparedBatch['created'] = new Map();
      for (const event of events) {
        if (event.type !== 'notification.created' || !event.userId) continue;
        const id = event.payload.notificationId;
        const notification = typeof id === 'string' ? views.get(id) : undefined;
        if (!notification || !audience.has(event.userId)) continue;
        created.set(event.id, {
          notification,
          unreadCount: counts.get(event.userId) ?? 0,
        });
      }
      return { tenantId, rows, created, unread: counts };
    });
  }

  shape(
    prepared: unknown,
    event: RealtimeEventRow,
    reader: { userId: string; ability: PermissionCheck },
  ): SseFrame | null {
    const batch = prepared as PreparedBatch;
    if (isRequestStreamType(event.type)) {
      if (!event.requestId) return null;
      const previous = event.payload.previousCustomerKey;
      const shaped = this.reads.shapeEventRow(
        batch.rows,
        event.requestId,
        reader,
        typeof previous === 'string' ? previous : null,
      );
      return shaped ? { id: event.id, event: event.type, data: shaped } : null;
    }
    if (!isNotificationStreamType(event.type)) return null;
    // Notification events are addressed to one person, never to anyone else.
    if (event.userId !== reader.userId) return null;
    if (event.type === 'notification.created') {
      const view = batch.created.get(event.id);
      return view ? { id: event.id, event: event.type, data: view } : null;
    }
    const ids = event.payload.ids;
    return {
      id: event.id,
      event: event.type,
      data: {
        ids: Array.isArray(ids) ? ids : null,
        all: event.payload.all === true,
        unreadCount: batch.unread.get(reader.userId) ?? 0,
      },
    };
  }
}
