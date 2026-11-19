/**
 * What the realtime shaper reads about conversation messages (unit 9; contract
 * §12.8), in BATCHES: a batch of events costs one query for the messages (plus
 * one for their files and one for their staff authors), however many events it
 * holds. Runs inside the tenant scope the shaper opened.
 */
import type { MessageView } from '../../conversations/domain/message-view';

export interface ConversationEventReader {
  /**
   * The CURRENT view of each message by id (the log holds ids, not words). A
   * message that was purged or belongs to another tenant is simply absent.
   */
  messages(ids: readonly string[]): Promise<Map<string, MessageView>>;
}

export const REALTIME_CONVERSATION_READER = Symbol(
  'REALTIME_CONVERSATION_READER',
);
