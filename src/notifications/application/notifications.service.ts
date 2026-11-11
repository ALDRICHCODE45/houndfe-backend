/**
 * Notifications API of the signed-in person (contract §5.2). Everything is
 * scoped by the tenant of the JWT AND the caller's own `userId`: there is no
 * way to name another user, so one person can never read or mark another's
 * notices (a foreign id answers 404 like a missing one).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  noticeText,
  type NoticePayload,
} from '../domain/chatbot-request-notice';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  requestId: string | null;
  createdAt: string;
  readAt: string | null;
}

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
    const where: Prisma.NotificationWhereInput = {
      ...this.own(userId),
      ...(query.unread ? { readAt: null } : {}),
    };
    if (query.cursor) {
      const { createdAt, id } = decodeCursor(query.cursor);
      where.OR = [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: id } },
      ];
    }
    const rows = await this.db.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        type: row.type,
        ...noticeText(row.type, row.payload as Partial<NoticePayload> | null),
        requestId: row.requestId,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.createdAt, last.id)
          : null,
    };
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.db.notification.count({
      where: { ...this.own(userId), readAt: null },
    });
    return { count };
  }

  /** Idempotent: reading an already read notice keeps its first `readAt`. */
  async markRead(
    userId: string,
    id: string,
  ): Promise<{ id: string; readAt: string }> {
    const where = { ...this.own(userId), id };
    await this.db.notification.updateMany({
      where: { ...where, readAt: null },
      data: { readAt: new Date() },
    });
    const row = await this.db.notification.findFirst({
      where,
      select: { readAt: true },
    });
    if (!row?.readAt) throw new NotFoundException('Notification not found');
    return { id, readAt: row.readAt.toISOString() };
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const { count } = await this.db.notification.updateMany({
      where: { ...this.own(userId), readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
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
