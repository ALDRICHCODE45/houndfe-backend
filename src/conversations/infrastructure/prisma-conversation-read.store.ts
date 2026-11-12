/**
 * Prisma adapter of the staff conversation read (unit 9). Everything goes
 * through the tenant-scoped client, so the tenant comes from CLS (the staff
 * guards) and never from the request. Paging uses `(conversationId, seq)`
 * unique index in both directions: one index range scan per page.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  ConversationPageRows,
  ConversationReadStore,
  ConversationRequestRef,
} from '../application/conversation-reads.service';
import type { ConversationPageQuery } from '../domain/conversation-page';
import type { MediaRecord, MessageRecord } from '../domain/message-view';

const MESSAGE_SELECT = {
  id: true,
  seq: true,
  direction: true,
  author: true,
  staffUserId: true,
  type: true,
  text: true,
  mediaId: true,
  clientMessageId: true,
  providerTimestamp: true,
  receivedAt: true,
  deliveryStatus: true,
} as const;

@Injectable()
export class PrismaConversationReadStore implements ConversationReadStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private get db() {
    return this.tenantPrisma.getClient();
  }

  findRequest(requestId: string): Promise<ConversationRequestRef | null> {
    return this.db.chatbotRequest.findFirst({
      where: { id: requestId, tenantId: this.tenantPrisma.getTenantId() },
      select: {
        id: true,
        status: true,
        conversationRef: true,
        assigneeUserId: true,
      },
    });
  }

  async page(
    conversationRef: string,
    query: ConversationPageQuery,
  ): Promise<ConversationPageRows> {
    const tenantId = this.tenantPrisma.getTenantId();
    const conversation = await this.db.chatbotConversation.findFirst({
      where: { tenantId, conversationRef },
      select: { id: true },
    });
    if (!conversation) return { rows: [], hasMoreBefore: false };
    const where = { tenantId, conversationId: conversation.id };

    if (query.mode === 'after') {
      const rows = await this.db.conversationMessage.findMany({
        where: { ...where, seq: { gt: query.seq } },
        orderBy: { seq: 'asc' },
        take: query.limit,
        select: MESSAGE_SELECT,
      });
      if (rows.length === 0) return { rows: [], hasMoreBefore: false };
      const older = await this.db.conversationMessage.findFirst({
        where: { ...where, seq: { lt: rows[0].seq } },
        select: { id: true },
      });
      return { rows, hasMoreBefore: older !== null };
    }

    // Latest page and older pages: newest first, one extra row says "more".
    const found = await this.db.conversationMessage.findMany({
      where:
        query.mode === 'before' ? { ...where, seq: { lt: query.seq } } : where,
      orderBy: { seq: 'desc' },
      take: query.limit + 1,
      select: MESSAGE_SELECT,
    });
    return {
      rows: found.slice(0, query.limit).reverse(),
      hasMoreBefore: found.length > query.limit,
    };
  }

  /** The realtime shaper's batch read: current rows by id, this tenant only. */
  messagesByIds(ids: string[]): Promise<MessageRecord[]> {
    return this.db.conversationMessage.findMany({
      where: { tenantId: this.tenantPrisma.getTenantId(), id: { in: ids } },
      select: MESSAGE_SELECT,
    });
  }

  media(ids: string[]): Promise<MediaRecord[]> {
    return this.db.conversationMedia.findMany({
      where: { tenantId: this.tenantPrisma.getTenantId(), id: { in: ids } },
      select: { id: true, mimeType: true, sizeBytes: true, purgedAt: true },
    });
  }

  users(ids: string[]) {
    return this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
  }
}

export type { MessageRecord };
