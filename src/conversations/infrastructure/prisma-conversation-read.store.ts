/**
 * Prisma adapter of the staff conversation read (unit 9). Everything goes
 * through the tenant-scoped client, so the tenant comes from CLS (the staff
 * guards) and never from the request. Paging uses `(conversationId, seq)`
 * unique index in both directions: one index range scan per page.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  emitRealtimeEvents,
  type RealtimeEventDraft,
} from '../../shared/realtime/realtime-event-writes';
import { openRequestIds } from './open-request-ids';
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

  async sessionStartSeq(requestId: string): Promise<number | null> {
    const session = await this.db.chatbotLiveSession.findFirst({
      where: { tenantId: this.tenantPrisma.getTenantId(), requestId },
      orderBy: { epoch: 'desc' },
      select: { startSeq: true },
    });
    return session?.startSeq ?? null;
  }

  async page(
    conversationRef: string,
    query: ConversationPageQuery,
    minSeq?: number,
  ): Promise<ConversationPageRows> {
    const tenantId = this.tenantPrisma.getTenantId();
    const conversation = await this.db.chatbotConversation.findFirst({
      where: { tenantId, conversationRef },
      select: { id: true },
    });
    if (!conversation) return { rows: [], hasMoreBefore: false };
    const where = {
      tenantId,
      conversationId: conversation.id,
      // Unit 11: an attendee without `read:ChatbotConversation` sees their
      // session only (§2.5); the `seq` filters below add to this bound.
      ...(minSeq !== undefined ? { seq: { gte: minSeq } } : {}),
    };

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

  /**
   * S12: a staff member was shown messages up to `seq`. Moves the chat's
   * marker forward only (`GREATEST`, never back) and, when it moved, logs one
   * `request.updated` per open request of the chat in the same transaction, so
   * every staff screen refreshes its row (the count is read at delivery). The
   * UPDATE writes nothing when the marker is already there (a poll that shows
   * nothing new costs a no-op). Lock order = the mirror's: chat row, then the
   * realtime lock last.
   */
  markRead(conversationRef: string, seq: number): Promise<boolean> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();
      const moved = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "chatbot_conversations"
        SET "lastStaffReadSeq" = ${seq}, "lastStaffReadAt" = now()
        WHERE "tenantId" = ${tenantId} AND "conversationRef" = ${conversationRef}
          AND "lastStaffReadSeq" < ${seq}
        RETURNING "id"`);
      if (moved.length === 0) return false;
      const drafts: RealtimeEventDraft[] = (
        await openRequestIds(db, tenantId, conversationRef)
      ).map((requestId) => ({
        tenantId,
        userId: null,
        type: 'request.updated',
        requestId,
        payload: { cause: 'CONVERSATION_READ' },
      }));
      await emitRealtimeEvents(db, drafts);
      return true;
    });
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
