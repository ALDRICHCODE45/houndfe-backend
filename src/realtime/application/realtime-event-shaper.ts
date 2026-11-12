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
import { Injectable } from '@nestjs/common';
import {
  ChatbotRequestReadsService,
  type EventRowsBatch,
} from '../../chatbot-requests/application/chatbot-request-reads.service';
import type { PermissionCheck } from '../../chatbot-requests/domain/resolve-permissions';
import {
  NotificationsService,
  type NotificationView,
} from '../../notifications/application/notifications.service';
import { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import {
  isNotificationStreamType,
  isRequestStreamType,
  type SseFrame,
} from '../domain/realtime-events';
import type { RealtimeEventRow } from '../infrastructure/prisma-realtime-event.store';
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
    private readonly notifications: NotificationsService,
  ) {}

  prepare(
    tenantId: string,
    events: RealtimeEventRow[],
  ): Promise<PreparedBatch> {
    const requestIds = events
      .filter((e) => isRequestStreamType(e.type) && e.requestId)
      .map((e) => e.requestId as string);
    return this.tenants.runWithTenant(tenantId, async () => {
      const rows = await this.reads.loadEventRows(requestIds);
      const created: PreparedBatch['created'] = new Map();
      const unread: PreparedBatch['unread'] = new Map();
      for (const event of events) {
        if (event.type === 'notification.created' && event.userId) {
          const id = event.payload.notificationId;
          if (typeof id !== 'string') continue;
          const view = await this.notifications.eventView(event.userId, id);
          if (view) created.set(event.id, view);
        } else if (event.type === 'notification.read' && event.userId) {
          if (!unread.has(event.userId)) {
            const { count } = await this.notifications.unreadCount(
              event.userId,
            );
            unread.set(event.userId, count);
          }
        }
      }
      return { tenantId, rows, created, unread };
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
