/**
 * APPLICATION: recovery of the bot after `410 CURSOR_EXPIRED` (unit 5, slice
 * 5c; contract §3.3). `GET /chatbot-api/requests?status=open&updatedSince=`
 * hands back the bot-facing projection of every open request, plus the ones
 * closed at or after `updatedSince` (so the bot drops them), keyset-paginated
 * by `(updatedAt, id)`, each with its latest undelivered feed items.
 *
 * `nextCursor` is the tenant's feed position, read BEFORE the first page of
 * requests: whatever commits while the bot walks the pages comes after that
 * position in the feed, and whatever committed before it is in the pages. The
 * page cursor carries it, so every page answers the same value.
 */
import { Inject, Injectable } from '@nestjs/common';
import { formatCursor } from '../domain/chatbot-feed';
import {
  encodeRecoveryPage,
  parseRecoveryQuery,
  RECOVERY_LIMITS,
} from '../domain/chatbot-recovery';
import {
  toPendingView,
  type FeedItemRow,
  type PendingDeliveryView,
} from './chatbot-feed.service';
import { formatFolio } from './chatbot-request-commands.service';

export const CHATBOT_RECOVERY_STORE = Symbol('CHATBOT_RECOVERY_STORE');

export interface RecoveryRequestRow {
  id: string;
  folio: number;
  kind: string;
  subtype: string;
  status: string;
  conversationRef: string | null;
  humanDecisionId: string | null;
  deliveryZoneRequestId: string | null;
  receiptEvidenceId: string | null;
  whatsappWindowClosesAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export interface ChatbotRecoveryStore {
  /** The tenant's highest feed cursor, never below the retention watermark. */
  currentFeedCursor(): Promise<bigint>;
  /**
   * Requests ordered by `(updatedAt, id)`: every open request plus, when
   * `since` is set, the ones closed at or after it; only those after `after`.
   */
  readPage(query: {
    since: Date | null;
    after: { updatedAt: Date; id: string } | null;
    limit: number;
  }): Promise<RecoveryRequestRow[]>;
  /** Per request, its latest `perRequest` items with no terminal outcome. */
  undelivered(requestIds: string[], perRequest: number): Promise<FeedItemRow[]>;
  /** Per request with any: how many items have no terminal outcome, and the oldest. */
  undeliveredSummary(requestIds: string[]): Promise<UndeliveredSummary[]>;
}

export interface UndeliveredSummary {
  requestId: string;
  count: number;
  oldestCursor: bigint;
}

/** What the bot sees of a request: no customer, no staff, no free text. */
export interface RecoveryRequestView {
  id: string;
  folio: string;
  kind: string;
  subtype: string;
  status: string;
  conversationRef: string | null;
  /** The id the bot tracks from the create answer (`legacy.id`), if wrapped. */
  legacyId: string | null;
  whatsappWindowClosesAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pendingDeliveries: PendingDeliveryView[];
  /** More undelivered items exist than `pendingDeliveries` lists. */
  undeliveredTruncated: boolean;
  /**
   * When truncated: the feed `after` that serves this request's oldest
   * undelivered item again (its cursor minus one). Resume the feed from the
   * smallest of these and `nextCursor`. `null` otherwise.
   */
  undeliveredResumeAfter: string | null;
}

export interface RecoveryAnswer {
  items: RecoveryRequestView[];
  /** The feed position to resume from (`GET /chatbot-api/feed?after=`). */
  nextCursor: string;
  /** `cursor` of the next page; `null` on the last one. */
  nextPage: string | null;
}

function truncation(summary: UndeliveredSummary | undefined) {
  const truncated =
    summary !== undefined &&
    summary.count > RECOVERY_LIMITS.deliveriesPerRequest;
  return {
    undeliveredTruncated: truncated,
    undeliveredResumeAfter:
      truncated && summary ? formatCursor(summary.oldestCursor - 1n) : null,
  };
}

const iso = (date: Date | null): string | null =>
  date ? date.toISOString() : null;

@Injectable()
export class ChatbotRecoveryService {
  constructor(
    @Inject(CHATBOT_RECOVERY_STORE)
    private readonly store: ChatbotRecoveryStore,
  ) {}

  async recover(query: Record<string, unknown>): Promise<RecoveryAnswer> {
    const { updatedSince, page, limit } = parseRecoveryQuery(query);
    const feedCursor =
      page?.feedCursor ?? (await this.store.currentFeedCursor());
    const rows = await this.store.readPage({
      since: updatedSince
        ? new Date(updatedSince.getTime() - RECOVERY_LIMITS.clockSkewMs)
        : null,
      after: page ? { updatedAt: page.updatedAt, id: page.id } : null,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const ids = pageRows.map((row) => row.id);
    const [deliveries, summaries] =
      ids.length === 0
        ? [[], []]
        : await Promise.all([
            this.store.undelivered(ids, RECOVERY_LIMITS.deliveriesPerRequest),
            this.store.undeliveredSummary(ids),
          ]);
    const summaryOf = new Map(summaries.map((item) => [item.requestId, item]));
    const byRequest = new Map<string, PendingDeliveryView[]>();
    for (const delivery of deliveries) {
      const list = byRequest.get(delivery.requestId) ?? [];
      list.push(toPendingView(delivery));
      byRequest.set(delivery.requestId, list);
    }

    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => ({
        id: row.id,
        folio: formatFolio(row.folio),
        kind: row.kind,
        subtype: row.subtype,
        status: row.status,
        conversationRef: row.conversationRef,
        legacyId:
          row.humanDecisionId ??
          row.deliveryZoneRequestId ??
          row.receiptEvidenceId,
        whatsappWindowClosesAt: iso(row.whatsappWindowClosesAt),
        cancelReason: row.cancelReason,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        closedAt: iso(row.closedAt),
        pendingDeliveries: byRequest.get(row.id) ?? [],
        ...truncation(summaryOf.get(row.id)),
      })),
      nextCursor: formatCursor(feedCursor),
      nextPage:
        hasMore && last
          ? encodeRecoveryPage({
              updatedAt: last.updatedAt,
              id: last.id,
              feedCursor,
            })
          : null,
    };
  }
}
