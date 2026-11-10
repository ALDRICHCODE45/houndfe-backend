/**
 * APPLICATION: the bot feed (unit 5, slice 5b; contract §3.3, §4.5, §10.1
 * R2/R7). Long-poll over a cursor, the pending (deferred) deliveries and the
 * delivery outcome.
 *
 * A long-poll holds no database connection while it waits: it arms a wake-up
 * (a `NOTIFY` listener shared by the replica), reads with a short query that
 * releases its connection, and when the feed is empty waits on the wake-up.
 * The wake-up is armed BEFORE the read, so a notification that lands between
 * the read and the wait is not lost. Per credential at most 2 polls wait at the
 * same time (R2); a poll that is answered at once never takes a slot.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  FEED_LIMITS,
  formatCursor,
  hashFeedOutcome,
  parseFeedOutcome,
  type FeedOutcome,
  type FeedOutcomeInput,
} from '../domain/chatbot-feed';
import { ChatbotRequestCommandError } from './chatbot-request-commands.service';

export const CHATBOT_FEED_STORE = Symbol('CHATBOT_FEED_STORE');
export const FEED_WAKEUP = Symbol('FEED_WAKEUP');
export const FEED_CLOCK = Symbol('FEED_CLOCK');

export interface FeedItemRow {
  cursor: bigint;
  deliveryId: string;
  type: string;
  requestId: string;
  conversationRef: string | null;
  payload: unknown;
}

export interface FeedItemView {
  cursor: string;
  deliveryId: string;
  type: string;
  requestId: string;
  conversationRef: string | null;
  payload: unknown;
  notBefore: null;
  expiresAt: null;
}

export interface OutcomeAck {
  deliveryId: string;
  outcome: FeedOutcome;
  attemptId: string;
  /** `null` while the delivery is only deferred (still pending). */
  ackReceivedAt: string | null;
}

export interface ChatbotFeedStore {
  /** 410 CURSOR_EXPIRED when the retention purge passed this cursor. */
  assertCursorRetained(after: bigint): Promise<void>;
  readAfter(after: bigint, limit: number): Promise<FeedItemRow[]>;
  pendingDeferred(
    conversationRef: string,
    limit: number,
  ): Promise<FeedItemRow[]>;
  /** Locks the delivery, classifies, writes the outcome and its audit event. */
  recordOutcome(
    deliveryId: string,
    credentialId: string,
    input: FeedOutcomeInput,
    hash: string,
  ): Promise<OutcomeAck>;
}

export interface FeedWaiter {
  /** Resolves on a wake-up, at the timeout, or when `signal` aborts. */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

export interface FeedWakeupPort {
  arm(tenantId: string): Promise<FeedWaiter>;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function toView(row: FeedItemRow): FeedItemView {
  return {
    cursor: formatCursor(row.cursor),
    deliveryId: row.deliveryId,
    type: row.type,
    requestId: row.requestId,
    conversationRef: row.conversationRef,
    payload: row.payload,
    notBefore: null,
    expiresAt: null,
  };
}

@Injectable()
export class ChatbotFeedService {
  /** Waiting long-polls per credential, in this replica. */
  private readonly waiting = new Map<string, number>();

  constructor(
    @Inject(CHATBOT_FEED_STORE) private readonly store: ChatbotFeedStore,
    @Inject(FEED_WAKEUP) private readonly wakeup: FeedWakeupPort,
    @Inject(FEED_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  async poll(input: {
    tenantId: string;
    credentialId: string;
    after: bigint;
    limit: number;
    waitSeconds: number;
    signal?: AbortSignal;
  }): Promise<{ items: FeedItemView[]; nextCursor: string }> {
    const { tenantId, credentialId, after, limit, signal } = input;
    if (after > 0n) await this.store.assertCursorRetained(after);
    const deadline = this.now() + input.waitSeconds * 1000;
    let holdsSlot = false;
    try {
      for (;;) {
        const waiter = await this.wakeup.arm(tenantId);
        try {
          const rows = await this.store.readAfter(after, limit);
          const remaining = deadline - this.now();
          if (rows.length > 0 || remaining <= 0 || signal?.aborted) {
            return {
              items: rows.map(toView),
              nextCursor: formatCursor(rows.at(-1)?.cursor ?? after),
            };
          }
          if (!holdsSlot) {
            this.takeSlot(credentialId);
            holdsSlot = true;
          }
          await waiter.wait(remaining, signal);
        } finally {
          waiter.dispose();
        }
      }
    } finally {
      if (holdsSlot) this.freeSlot(credentialId);
    }
  }

  /** Deliveries a bot deferred because the 24 h window was closed (§4.5). */
  async pending(
    conversationRef: string | undefined,
  ): Promise<{ items: FeedItemView[] }> {
    if (!conversationRef || conversationRef.length > 200) {
      throw new InvalidArgumentError(
        'Invalid feed request',
        'INVALID_FEED_REQUEST',
      );
    }
    const rows = await this.store.pendingDeferred(
      conversationRef,
      FEED_LIMITS.maxLimit,
    );
    return { items: rows.map(toView) };
  }

  async outcome(input: {
    deliveryId: string;
    credentialId: string;
    body: unknown;
  }): Promise<OutcomeAck> {
    if (!UUID.test(input.deliveryId)) {
      throw new InvalidArgumentError(
        'Invalid feed request',
        'INVALID_FEED_REQUEST',
      );
    }
    const outcome = parseFeedOutcome(input.body);
    return this.store.recordOutcome(
      input.deliveryId,
      input.credentialId,
      outcome,
      hashFeedOutcome(outcome),
    );
  }

  private takeSlot(credentialId: string): void {
    const open = this.waiting.get(credentialId) ?? 0;
    if (open >= FEED_LIMITS.maxConcurrentPolls) {
      throw new ChatbotRequestCommandError('RATE_LIMITED', 429, undefined, {
        retryAfterSeconds: 1,
      });
    }
    this.waiting.set(credentialId, open + 1);
  }

  private freeSlot(credentialId: string): void {
    const open = (this.waiting.get(credentialId) ?? 1) - 1;
    if (open <= 0) this.waiting.delete(credentialId);
    else this.waiting.set(credentialId, open);
  }
}
