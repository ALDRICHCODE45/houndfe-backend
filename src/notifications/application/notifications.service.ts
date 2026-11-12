/**
 * Notifications API of the signed-in person (contract §5.2). Everything is
 * scoped by the tenant of the JWT AND the caller's own `userId`: there is no
 * way to name another user, so one person can never read or mark another's
 * notices (a foreign id answers 404 like a missing one).
 */
import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  NOTIFICATION_READ_EVENTS,
  type NotificationReadEventsPort,
} from '../domain/notification-events.port';
import {
  toNotificationView,
  type NotificationView,
} from '../domain/notification-view';
import {
  findNotificationRows,
  listNotificationRows,
} from '../infrastructure/notification-rows';

// The view type lives with its mapping; this module keeps exporting it.
export type { NotificationView };

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
}

export interface NotificationPreferences {
  emailEnabled: boolean;
  soundEnabled: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  emailEnabled: true,
  soundEnabled: true,
};

/** Opaque keyset cursor over `(createdAt desc, id desc)`. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new InvalidArgumentError('Invalid cursor', 'VALIDATION_ERROR');
  }
  return { createdAt, id };
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly prisma: PrismaService,
    // Unit 8: announces reads to the person's other tabs. Optional so the
    // service (and its specs) work unchanged where the stream is not served.
    @Optional()
    @Inject(NOTIFICATION_READ_EVENTS)
    private readonly readEvents?: NotificationReadEventsPort,
  ) {}

  private get db() {
    return this.tenantPrisma.getClient();
  }

  private own(userId: string) {
    return { tenantId: this.tenantPrisma.getTenantId(), userId };
  }

  async list(
    userId: string,
    query: { cursor?: string; limit?: number; unread?: boolean },
  ): Promise<NotificationPage> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    // One statement: the notices LEFT JOINed with their request (`requestOpen`).
    const rows = await listNotificationRows(this.db, {
      tenantId: this.tenantPrisma.getTenantId(),
      userId,
      unreadOnly: query.unread === true,
      after: query.cursor ? decodeCursor(query.cursor) : undefined,
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toNotificationView(row)),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.createdAt, last.id)
          : null,
    };
  }

  /**
   * Unit 8: the payload of a `notification.created` event, for ONE person: the
   * notice (same shape as the list) and their unread count at this moment.
   * `null` when the notice is gone (purged) or is not theirs.
   */
  async eventView(
    userId: string,
    id: string,
  ): Promise<{ notification: NotificationView; unreadCount: number } | null> {
    const [row] = await findNotificationRows(this.db, {
      tenantId: this.tenantPrisma.getTenantId(),
      userIds: [userId],
      ids: [id],
    });
    if (!row) return null;
    const { count } = await this.unreadCount(userId);
    return { notification: toNotificationView(row), unreadCount: count };
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.db.notification.count({
      where: { ...this.own(userId), readAt: null },
    });
    return { count };
  }

  /** Idempotent: reading an already read notice keeps its first `readAt`. */
  markRead(
    userId: string,
    id: string,
  ): Promise<{ id: string; readAt: string }> {
    return this.announcing(async () => {
      const where = { ...this.own(userId), id };
      const { count } = await this.db.notification.updateMany({
        where: { ...where, readAt: null },
        data: { readAt: new Date() },
      });
      const row = await this.db.notification.findFirst({
        where,
        select: { readAt: true },
      });
      if (!row?.readAt) throw new NotFoundException('Notification not found');
      // Only a change is announced: a repeat read tells nobody anything.
      if (count > 0) await this.publishRead(userId, [id], false);
      return { id, readAt: row.readAt.toISOString() };
    });
  }

  markAllRead(userId: string): Promise<{ updated: number }> {
    return this.announcing(async () => {
      const { count } = await this.db.notification.updateMany({
        where: { ...this.own(userId), readAt: null },
        data: { readAt: new Date() },
      });
      if (count > 0) await this.publishRead(userId, null, true);
      return { updated: count };
    });
  }

  /**
   * Runs the update and its realtime event in ONE transaction when the stream
   * is wired; without a writer it is exactly the statements as before.
   */
  private announcing<T>(work: () => Promise<T>): Promise<T> {
    return this.readEvents ? this.tenantPrisma.runInTransaction(work) : work();
  }

  private async publishRead(
    userId: string,
    ids: string[] | null,
    all: boolean,
  ): Promise<void> {
    if (!this.readEvents) return;
    // SAFETY: inside `announcing` the client is the ambient transaction client.
    await this.readEvents.publishRead(
      this.db as unknown as Prisma.TransactionClient,
      { tenantId: this.tenantPrisma.getTenantId(), userId, ids, all },
    );
  }

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const row = await this.prisma.notificationPreference.findUnique({
      where: { userId },
      select: { emailEnabled: true, soundEnabled: true },
    });
    return row ?? { ...DEFAULT_PREFERENCES };
  }

  /** Upsert of the given flags; the other keeps its stored (or default) value. */
  async setPreferences(
    userId: string,
    patch: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...DEFAULT_PREFERENCES, ...patch },
      update: patch,
      select: { emailEnabled: true, soundEnabled: true },
    });
  }
}
