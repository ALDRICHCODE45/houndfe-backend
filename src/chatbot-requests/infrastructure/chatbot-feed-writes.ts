/**
 * Enqueue into the bot feed (unit 5, slice 5b), always on the caller's
 * transaction so the state change and its feed item commit or roll back
 * together (§2.1: one state).
 *
 * Order guarantee: the cursor is a global sequence, so two transactions of one
 * tenant could take cursors 5 and 6 and commit 6 first; a reader that saw 6
 * would skip 5 forever. A per-tenant advisory lock taken before the insert and
 * held to the commit makes cursor order the commit order for a tenant. It is
 * taken after the request rows and the wrapped rows are locked and before the
 * customer-group refresh, and nothing that waits on another lock runs while a
 * transaction holds it except that refresh: only enqueuers wait for it, and an
 * enqueuer never holds a group lock while waiting (see "Bot feed" in
 * docs/chatbot-requests-model.md).
 *
 * `NOTIFY` is part of the transaction: PostgreSQL delivers it at commit and
 * drops it on rollback.
 */
import { Prisma } from '@prisma/client';
import {
  buildAnswerPayload,
  buildCancelPayload,
  FEED_CHANNEL,
  FEED_TYPE,
  type AnswerSource,
} from '../domain/chatbot-feed';
import type { TenantClient } from './chatbot-request-writes';

interface FeedDraft {
  requestId: string;
  type: string;
  conversationRef: string | null;
  payload: Record<string, unknown>;
}

async function insertFeedItems(
  tx: TenantClient,
  tenantId: string,
  drafts: FeedDraft[],
): Promise<void> {
  if (drafts.length === 0) return;
  const key = `chatbot-feed:${tenantId}`;
  // Prisma cannot decode `void`; the cast keeps the transaction-scoped lock.
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`,
  );
  await tx.chatbotFeedItem.createMany({
    data: drafts.map((draft) => ({
      tenantId,
      requestId: draft.requestId,
      type: draft.type,
      conversationRef: draft.conversationRef,
      payload: draft.payload as Prisma.InputJsonObject,
    })),
  });
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_notify(${FEED_CHANNEL}, ${tenantId})::text`,
  );
}

const unresolved = (): never => {
  throw new Error('feed answer: the wrapped row is not resolved');
};

/**
 * One `request.answered` per resolved wrapped request (a zone resolve answers
 * every customer waiting on it, R9). Call it after the wrapped row was written
 * and while the requests are already `RESOLVED` in this transaction. The answer
 * is read from the wrapped row, the one record of what staff decided, so the
 * staff `resolve` and the legacy routes produce the same item. An item that
 * cannot be built fails the transaction instead of losing the answer.
 */
export async function enqueueAnswered(
  tx: TenantClient,
  tenantId: string,
  requestIds: string[],
): Promise<void> {
  if (requestIds.length === 0) return;
  const requests = await tx.chatbotRequest.findMany({
    where: { tenantId, id: { in: requestIds }, status: 'RESOLVED' },
    select: {
      id: true,
      subtype: true,
      conversationRef: true,
      humanDecisionId: true,
      deliveryZoneRequestId: true,
      receiptEvidenceId: true,
    },
  });
  if (requests.length !== requestIds.length) return unresolved();
  const ids = (pick: (r: (typeof requests)[number]) => string | null) =>
    requests.map(pick).filter((id): id is string => id !== null);
  const [decisions, zones, receipts] = await Promise.all([
    tx.humanDecision.findMany({
      where: { tenantId, id: { in: ids((r) => r.humanDecisionId) } },
      select: {
        id: true,
        status: true,
        productName: true,
        resolutionAction: true,
        restockDays: true,
        expirationText: true,
      },
    }),
    tx.deliveryZoneRequest.findMany({
      where: { tenantId, id: { in: ids((r) => r.deliveryZoneRequestId) } },
      select: {
        id: true,
        status: true,
        zipCode: true,
        zoneType: true,
        surchargeCents: true,
        etaDays: true,
      },
    }),
    tx.receiptEvidence.findMany({
      where: { tenantId, id: { in: ids((r) => r.receiptEvidenceId) } },
      select: { id: true, status: true, customerReason: true },
    }),
  ]);
  const byId = new Map(requests.map((request) => [request.id, request]));

  const drafts = requestIds.map((requestId): FeedDraft => {
    const request = byId.get(requestId) ?? unresolved();
    return {
      requestId,
      type: FEED_TYPE.answered,
      conversationRef: request.conversationRef,
      payload: buildAnswerPayload(
        answerSource(request, { decisions, zones, receipts }),
      ),
    };
  });
  await insertFeedItems(tx, tenantId, drafts);
}

function answerSource(
  request: {
    subtype: string;
    humanDecisionId: string | null;
    deliveryZoneRequestId: string | null;
    receiptEvidenceId: string | null;
  },
  wrapped: {
    decisions: Array<{
      id: string;
      status: string;
      productName: string;
      resolutionAction: string | null;
      restockDays: number | null;
      expirationText: string | null;
    }>;
    zones: Array<{
      id: string;
      status: string;
      zipCode: string;
      zoneType: string | null;
      surchargeCents: number | null;
      etaDays: number | null;
    }>;
    receipts: Array<{
      id: string;
      status: string;
      customerReason: string | null;
    }>;
  },
): AnswerSource {
  switch (request.subtype) {
    case 'RESTOCK':
    case 'EXPIRATION': {
      const decision = wrapped.decisions.find(
        (d) => d.id === request.humanDecisionId,
      );
      if (!decision || decision.status !== 'RESOLVED') return unresolved();
      const common = {
        legacyId: decision.id,
        productName: decision.productName,
      };
      return request.subtype === 'RESTOCK'
        ? {
            ...common,
            subtype: 'RESTOCK',
            action: decision.resolutionAction as Extract<
              AnswerSource,
              { subtype: 'RESTOCK' }
            >['action'],
            restockDays: decision.restockDays,
          }
        : {
            ...common,
            subtype: 'EXPIRATION',
            action: decision.resolutionAction as Extract<
              AnswerSource,
              { subtype: 'EXPIRATION' }
            >['action'],
            expirationText: decision.expirationText,
          };
    }
    case 'DELIVERY_ZONE': {
      const zone = wrapped.zones.find(
        (z) => z.id === request.deliveryZoneRequestId,
      );
      if (!zone || zone.status !== 'RESOLVED' || !zone.zoneType) {
        return unresolved();
      }
      return {
        subtype: 'DELIVERY_ZONE',
        legacyId: zone.id,
        zipCode: zone.zipCode,
        zoneType: zone.zoneType as Extract<
          AnswerSource,
          { subtype: 'DELIVERY_ZONE' }
        >['zoneType'],
        surchargeCents: zone.surchargeCents,
        etaDays: zone.etaDays,
      };
    }
    case 'TRANSFER_RECEIPT': {
      const receipt = wrapped.receipts.find(
        (r) => r.id === request.receiptEvidenceId,
      );
      if (!receipt || receipt.status === 'PENDING') return unresolved();
      return {
        subtype: 'TRANSFER_RECEIPT',
        legacyId: receipt.id,
        status: receipt.status as 'CONFIRMED' | 'REJECTED',
        customerReason: receipt.customerReason,
      };
    }
    default:
      return unresolved();
  }
}

/** `request.cancelled` (§12.14) for a staff cancellation. */
export async function enqueueCancelled(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
  reason: string,
  customerNote?: string,
): Promise<void> {
  const request = await tx.chatbotRequest.findFirst({
    where: { tenantId, id: requestId, status: 'CANCELLED' },
    select: { conversationRef: true },
  });
  if (!request) throw new Error('feed cancel: the request is not cancelled');
  await insertFeedItems(tx, tenantId, [
    {
      requestId,
      type: FEED_TYPE.cancelled,
      conversationRef: request.conversationRef,
      payload: buildCancelPayload({ requestId, reason, customerNote }),
    },
  ]);
}
