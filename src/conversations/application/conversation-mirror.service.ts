/**
 * APPLICATION: the bot's side of the conversation mirror (human-intervention
 * unit 9; contract §3.6, §3.9, §11.2). Two idempotent writes, both authorised
 * by the bot credential (the tenant comes from it, never from the body):
 *
 *   - `ingest`: a batch of customer and bot messages of one chat. Parsed by the
 *     exact parser (untrusted text), then stored by the store in one
 *     transaction.
 *   - `statuses`: Meta delivery statuses of messages we mirrored.
 *
 * Neither takes an `X-Idempotency-Key`: the contract's idempotency is by
 * `waMessageId` (messages) and by `(providerMessageId, status)` (statuses), so a
 * retry of the very same call is always safe.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ChatbotRequestCommandError } from '../../chatbot-requests/application/chatbot-request-commands.service';
import {
  MessageBatchTooLargeError,
  customerKeyFromConversationRef,
  parseConversationRef,
  parseMessageBatch,
  parseStatusBatch,
  type ParsedMessage,
  type ParsedStatus,
} from '../domain/conversation-message';

export const CONVERSATION_MIRROR_STORE = Symbol('CONVERSATION_MIRROR_STORE');
export const CONVERSATION_CLOCK = Symbol('CONVERSATION_CLOCK');

export interface IngestResult {
  /** The messages this call stored, in `seq` order. */
  accepted: Array<{ waMessageId: string; messageId: string; seq: number }>;
  /** `waMessageId`s that were already mirrored (ignored, not an error). */
  duplicates: string[];
  /**
   * S16 7b: the chat's handoff state as of this call (additive), so the bot
   * learns a missed `conversation.started`/`ended` from the answer it already
   * gets: `mode` is `HUMAN` while a live session holds the chat.
   */
  mode: 'BOT' | 'HUMAN';
  handoffEpoch: number;
}

export interface StatusResult {
  /** Statuses that moved a message forward. */
  applied: number;
  /** Known messages whose status was already equal or ahead (or not ours to move). */
  ignored: number;
  /** `providerMessageId`s that match no mirrored message (yet). */
  unknown: string[];
}

export interface ConversationMirrorStore {
  /**
   * One transaction: lock the chat, drop duplicates, check the media, assign
   * `seq`, insert, and write the realtime events. Throws
   * `ChatbotRequestCommandError` for a wamid owned by another chat (409) or a
   * missing / mismatched file (422).
   */
  ingest(input: {
    conversationRef: string;
    customerKey: string | null;
    messages: ParsedMessage[];
  }): Promise<IngestResult>;
  applyStatuses(statuses: ParsedStatus[]): Promise<StatusResult>;
}

@Injectable()
export class ConversationMirrorService {
  constructor(
    @Inject(CONVERSATION_MIRROR_STORE)
    private readonly store: ConversationMirrorStore,
    @Optional()
    @Inject(CONVERSATION_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async ingest(input: {
    conversationRef: unknown;
    body: unknown;
  }): Promise<IngestResult> {
    const conversationRef = parseConversationRef(input.conversationRef);
    const messages = this.guardBatch(() =>
      parseMessageBatch(input.body, this.clock()),
    );
    return this.store.ingest({
      conversationRef,
      customerKey: customerKeyFromConversationRef(conversationRef),
      messages,
    });
  }

  async statuses(input: { body: unknown }): Promise<StatusResult> {
    const statuses = this.guardBatch(() =>
      parseStatusBatch(input.body, this.clock()),
    );
    return this.store.applyStatuses(statuses);
  }

  private guardBatch<T>(parse: () => T): T {
    try {
      return parse();
    } catch (error) {
      if (error instanceof MessageBatchTooLargeError) {
        throw new ChatbotRequestCommandError(
          'BATCH_TOO_LARGE',
          413,
          undefined,
          { limit: error.limit },
        );
      }
      throw error;
    }
  }
}
