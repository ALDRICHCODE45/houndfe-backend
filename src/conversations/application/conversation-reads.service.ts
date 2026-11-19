/**
 * APPLICATION: the staff read of a request's conversation (human-intervention
 * unit 9; contract §3.6, §3.8, §12.5, §2.5, R12).
 *
 *   - tenant isolation: the request is read through the tenant-scoped client,
 *     so another tenant's id is a 404 exactly like an unknown one;
 *   - permission: `read:ChatbotConversation` sees the whole chat. Someone who
 *     attends the request without it sees only the messages of THEIR session
 *     (§2.5); live sessions are unit 11, so until then that set is empty and
 *     the answer is an empty page. Anyone else is a 403;
 *   - R12: the answer carries no `conversationRef` (it embeds the customer's
 *     phone), no customer key and no storage key: the customer card comes from
 *     the request detail, through `toStaffPhone`.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatbotRequestCommandError } from '../../chatbot-requests/application/chatbot-request-commands.service';
import type { PermissionCheck } from '../../chatbot-requests/domain/resolve-permissions';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import { actorDisplayName } from '../../chatbot-requests/domain/actor-display-name';
import {
  parseConversationPageQuery,
  type ConversationPageQuery,
} from '../domain/conversation-page';
import {
  toMessageView,
  type MediaRecord,
  type MessageRecord,
  type MessageView,
} from '../domain/message-view';

export const CONVERSATION_READ_STORE = Symbol('CONVERSATION_READ_STORE');

export interface ConversationRequestRef {
  id: string;
  status: string;
  conversationRef: string | null;
  assigneeUserId: string | null;
}

export interface ConversationPageRows {
  rows: MessageRecord[];
  hasMoreBefore: boolean;
}

export interface ConversationReadStore {
  /** Tenant-scoped: another tenant's request is `null`. */
  findRequest(requestId: string): Promise<ConversationRequestRef | null>;
  /** `rows` ascending by `seq`. `[]` when the chat was never mirrored. */
  page(
    conversationRef: string,
    query: ConversationPageQuery,
    /** Unit 11: only messages with `seq >= minSeq` (an attendee's own session). */
    minSeq?: number,
  ): Promise<ConversationPageRows>;
  /**
   * Unit 11: `startSeq` of the request's newest live session (the first message
   * of the attendee's session, §2.5), or `null` when it never had one.
   */
  sessionStartSeq(requestId: string): Promise<number | null>;
  /**
   * S12: staff were shown the chat up to `seq`: advance the chat's read marker
   * (never back) and tell the open requests' screens when it moved.
   */
  markRead(conversationRef: string, seq: number): Promise<boolean>;
  media(ids: string[]): Promise<MediaRecord[]>;
  users(
    ids: string[],
  ): Promise<Array<{ id: string; name: string; email: string }>>;
}

export interface ConversationReader {
  userId: string;
  ability: PermissionCheck;
}

export interface ConversationPageView {
  items: MessageView[];
  hasMoreBefore: boolean;
}

const EMPTY: ConversationPageView = { items: [], hasMoreBefore: false };

/** Message rows and the people and files they point at, as views. */
export async function toMessageViews(
  store: Pick<ConversationReadStore, 'media' | 'users'>,
  rows: MessageRecord[],
): Promise<MessageView[]> {
  const mediaIds = [
    ...new Set(rows.flatMap((r) => (r.mediaId ? [r.mediaId] : []))),
  ];
  const staffIds = [
    ...new Set(rows.flatMap((r) => (r.staffUserId ? [r.staffUserId] : []))),
  ];
  const [media, users] = await Promise.all([
    mediaIds.length > 0 ? store.media(mediaIds) : Promise.resolve([]),
    staffIds.length > 0 ? store.users(staffIds) : Promise.resolve([]),
  ]);
  const mediaById = new Map(media.map((m) => [m.id, m]));
  const staffById = new Map(
    users.map((u) => [u.id, { id: u.id, displayName: actorDisplayName(u) }]),
  );
  return rows.map((row) =>
    toMessageView(row, {
      media: row.mediaId ? (mediaById.get(row.mediaId) ?? null) : null,
      staff: row.staffUserId ? (staffById.get(row.staffUserId) ?? null) : null,
    }),
  );
}

@Injectable()
export class ConversationReadsService {
  private readonly logger = new Logger(ConversationReadsService.name);

  constructor(
    @Inject(CONVERSATION_READ_STORE)
    private readonly store: ConversationReadStore,
  ) {}

  async page(
    reader: ConversationReader,
    requestId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<ConversationPageView> {
    const query = parseConversationPageQuery(rawQuery);
    const request = await this.store.findRequest(requestId);
    if (!request) throw new ChatbotRequestCommandError('NOT_FOUND', 404);

    if (!reader.ability.can('read', 'ChatbotConversation')) {
      const attends =
        request.status === 'IN_PROGRESS' &&
        request.assigneeUserId === reader.userId;
      if (!attends) throw new InsufficientPermissionsError();
      // §2.5: without `read:ChatbotConversation` the attendee sees only the
      // messages of THEIR session (from its first `seq` on).
      if (!request.conversationRef) return EMPTY;
      const startSeq = await this.store.sessionStartSeq(request.id);
      if (startSeq === null) return EMPTY;
      return this.pageOf(request.conversationRef, query, startSeq, false);
    }
    if (!request.conversationRef) return EMPTY;
    return this.pageOf(request.conversationRef, query, undefined, true);
  }

  /**
   * One page of the chat. `minSeq` limits it to an attendee's own session
   * (§2.5); only a reader of the whole chat (`opens`) moves the read marker.
   */
  private async pageOf(
    conversationRef: string,
    query: ConversationPageQuery,
    minSeq: number | undefined,
    opens: boolean,
  ): Promise<ConversationPageView> {
    const { rows, hasMoreBefore } = await this.store.page(
      conversationRef,
      query,
      minSeq,
    );
    if (rows.length === 0) return EMPTY;
    const items = await toMessageViews(this.store, rows);
    // S12: only a reader of the whole chat "opens" it, and only up to the
    // newest message this page actually showed (an older page moves nothing; a
    // message that arrived while the page was being built stays unread). The
    // marker never blocks the read: a failure to move it is logged, not thrown.
    if (!opens) return { items, hasMoreBefore };
    try {
      await this.store.markRead(conversationRef, rows[rows.length - 1].seq);
    } catch (error) {
      this.logger.warn(
        `conversation read marker not moved (${error instanceof Error ? error.name : 'unknown'})`,
      );
    }
    return { items, hasMoreBefore };
  }
}
