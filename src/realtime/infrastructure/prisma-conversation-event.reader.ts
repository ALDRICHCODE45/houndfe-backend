/**
 * Batched message reads for the realtime shaper (unit 9). The same row-to-view
 * mapping and the same file / staff lookups as the REST read (`toMessageViews`
 * over `PrismaConversationReadStore`), so the stream shows what REST shows;
 * tenant-scoped through CLS (the shaper opens the scope) plus an explicit
 * `tenantId` in every statement.
 */
import { Injectable } from '@nestjs/common';
import { toMessageViews } from '../../conversations/application/conversation-reads.service';
import type { MessageView } from '../../conversations/domain/message-view';
import { PrismaConversationReadStore } from '../../conversations/infrastructure/prisma-conversation-read.store';
import type { ConversationEventReader } from '../application/conversation-event-reader';

@Injectable()
export class PrismaConversationEventReader implements ConversationEventReader {
  constructor(private readonly store: PrismaConversationReadStore) {}

  async messages(ids: readonly string[]): Promise<Map<string, MessageView>> {
    if (ids.length === 0) return new Map();
    const rows = await this.store.messagesByIds([...ids]);
    const views = await toMessageViews(this.store, rows);
    return new Map(views.map((view) => [view.id, view]));
  }
}
