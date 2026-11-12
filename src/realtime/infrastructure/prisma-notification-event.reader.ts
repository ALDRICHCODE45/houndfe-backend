/**
 * Batched notification reads for the realtime shaper (unit 8). Same row-to-view
 * mapping as `NotificationsService` (the list route), so the stream shows what
 * REST shows; `prisma-notification-event.reader.integration.spec.ts` pins the
 * two together. Tenant-scoped client (CLS) plus an explicit `tenantId`.
 */
import { Injectable } from '@nestjs/common';
import {
  noticeText,
  type NoticePayload,
} from '../../notifications/domain/chatbot-request-notice';
import type { NotificationView } from '../../notifications/application/notifications.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { NotificationEventReader } from '../application/notification-event-reader';

@Injectable()
export class PrismaNotificationEventReader implements NotificationEventReader {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async views(
    wanted: ReadonlyArray<{ userId: string; id: string }>,
  ): Promise<Map<string, NotificationView>> {
    const out = new Map<string, NotificationView>();
    if (wanted.length === 0) return out;
    const owner = new Map(wanted.map((w) => [w.id, w.userId]));
    const rows = await this.tenantPrisma.getClient().notification.findMany({
      where: {
        tenantId: this.tenantPrisma.getTenantId(),
        userId: { in: [...new Set(wanted.map((w) => w.userId))] },
        id: { in: [...owner.keys()] },
      },
    });
    for (const row of rows) {
      // One id, one owner: a notice that is someone else's is not returned.
      if (owner.get(row.id) !== row.userId) continue;
      out.set(row.id, {
        id: row.id,
        type: row.type,
        ...noticeText(row.type, row.payload as Partial<NoticePayload> | null),
        requestId: row.requestId,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
      });
    }
    return out;
  }

  async unreadCounts(userIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>(userIds.map((id) => [id, 0]));
    if (userIds.length === 0) return out;
    const groups = await this.tenantPrisma.getClient().notification.groupBy({
      by: ['userId'],
      where: {
        tenantId: this.tenantPrisma.getTenantId(),
        userId: { in: [...userIds] },
        readAt: null,
      },
      _count: { _all: true },
    });
    for (const g of groups) out.set(g.userId, g._count._all);
    return out;
  }
}
