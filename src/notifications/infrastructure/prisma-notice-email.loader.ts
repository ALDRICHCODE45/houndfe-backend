/**
 * Loads what one notice email needs. Runs on the root client with explicit
 * tenant and user filters (no CLS: this runs in an Inngest handler). It reads
 * the folio and subtype from the notification payload and never touches the
 * customer: name and phone are not selected anywhere (§6.3).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  NOTICE_TYPES,
  type NoticePayload,
  type NoticeType,
} from '../domain/chatbot-request-notice';
import type {
  INoticeEmailLoader,
  NoticeEmailLoad,
} from '../inngest/chatbot-request-email.functions';
import type { NoticeEmailEvent } from '../outbox/chatbot-request-email.dispatcher';

@Injectable()
export class PrismaNoticeEmailLoader implements INoticeEmailLoader {
  constructor(private readonly prisma: PrismaService) {}

  async load(event: NoticeEmailEvent): Promise<NoticeEmailLoad | null> {
    const { tenantId, userId } = event;
    const membership = await this.prisma.tenantMembership.findFirst({
      where: { tenantId, userId, user: { isActive: true } },
      select: {
        user: {
          select: {
            email: true,
            notificationPreference: { select: { emailEnabled: true } },
          },
        },
        tenant: { select: { name: true } },
      },
    });
    if (!membership) return null;
    // No preference row means the default: email on.
    if (membership.user.notificationPreference?.emailEnabled === false) {
      return null;
    }
    const rows = await this.prisma.notification.findMany({
      where: { tenantId, userId, id: { in: event.notificationIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { type: true, requestId: true, payload: true },
    });
    const items = rows.flatMap((row) => {
      const payload = row.payload as Partial<NoticePayload> | null;
      if (
        !row.requestId ||
        !NOTICE_TYPES.includes(row.type as NoticeType) ||
        typeof payload?.folio !== 'number' ||
        typeof payload.subtype !== 'string'
      ) {
        return [];
      }
      return [
        {
          type: row.type as NoticeType,
          requestId: row.requestId,
          folio: payload.folio,
          subtype: payload.subtype,
        },
      ];
    });
    return {
      email: membership.user.email,
      branchName: membership.tenant.name,
      items,
    };
  }
}
