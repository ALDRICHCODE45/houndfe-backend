/**
 * restock-backorder / T2b (contract v1 §10) — the backorder-level items of the
 * bot feed: `backorder.reserved`, `backorder.reservation_reminder`,
 * `backorder.reservation_expired`, `backorder.cancelled_by_staff` (T5),
 * `backorder.eta_updated` / `backorder.eta_unavailable` (T4) and
 * `backorder.reservation_lost`.
 *
 * Always on the caller's transaction (the state change and its item commit or
 * roll back together) through `insertFeedItems`, so they share the feed's
 * per-tenant advisory lock (cursor order is commit order) and its `NOTIFY`.
 * Each function READS the backorder row inside that transaction after the
 * caller wrote the state change, so the payload is the row as committed and
 * `version` (the exactly-once key) is the version of that state.
 *
 * Lock order: stock (journal) → backorder row → the feed's advisory lock LAST.
 * Callers hold the backorder row (and, where stock moved, the stock locks)
 * before calling; nothing takes a stock or backorder lock while holding the
 * feed lock, so the sweep, the allocator, a bot cancel and the feed ACK never
 * deadlock.
 *
 * Exactly once per (backorder, type, version): the partial unique index
 * `chatbot_feed_items_backorder_stage_uq` (migration 20261121000000) with
 * `ON CONFLICT DO NOTHING`, so a retry, a second sweep replica or a repeated
 * call is a no-op (`false`).
 *
 * The item is delivered to the customer's conversation, resolved like the
 * sale items (`saleConversationRef`): the one mirrored chat of the customer's
 * phone key, else `null` (the bot then resolves the customer from the
 * backorder through `GET /chatbot-api/backorders/:id`).
 */
import { Prisma } from '@prisma/client';
import {
  buildBackorderCancelledByStaffPayload,
  buildBackorderEtaUnavailablePayload,
  buildBackorderEtaUpdatedPayload,
  buildBackorderReservationExpiredPayload,
  buildBackorderReservationLostPayload,
  buildBackorderReservationReminderPayload,
  buildBackorderReservedPayload,
  FEED_TYPE,
  type BackorderPayloadBase,
} from '../../chatbot-requests/domain/chatbot-feed';
import { insertFeedItems } from '../../chatbot-requests/infrastructure/chatbot-feed-writes';
import type { TenantClient } from '../../chatbot-requests/infrastructure/chatbot-request-writes';
import { saleConversationRef } from '../../chatbot-requests/infrastructure/sale-feed-writes';
import type { BackorderNoticeSubject } from '../../notifications/infrastructure/backorder-notice.writer';

const FEED_SELECT = {
  id: true,
  folio: true,
  version: true,
  status: true,
  quantity: true,
  productId: true,
  variantId: true,
  customerId: true,
  sourceDecisionId: true,
  referencePriceCents: true,
  currentPriceCents: true,
  finalPriceCents: true,
  scheduledAt: true,
  estimatedAt: true,
  estimatedArrivalDays: true,
  reservedUntil: true,
  reminderAt: true,
  expiredAt: true,
  cancelReason: true,
  product: { select: { name: true } },
  variant: { select: { name: true } },
  customer: { select: { firstName: true } },
  tenant: { select: { name: true } },
} satisfies Prisma.BackorderSelect;

type FeedBackorder = Prisma.BackorderGetPayload<{
  select: typeof FEED_SELECT;
}>;

/** The backorder as the feed item sees it, read on the caller's transaction. */
async function readBackorder(
  tx: TenantClient,
  tenantId: string,
  backorderId: string,
): Promise<FeedBackorder> {
  const row = await tx.backorder.findFirst({
    where: { id: backorderId, tenantId },
    select: FEED_SELECT,
  });
  if (!row) throw new Error('feed backorder: the backorder does not exist');
  return row;
}

/** The fields every notice names (reserved / expired / undelivered). */
export async function backorderNoticeSubject(
  tx: TenantClient,
  tenantId: string,
  backorderId: string,
): Promise<BackorderNoticeSubject & { version: number }> {
  const row = await readBackorder(tx, tenantId, backorderId);
  return {
    id: row.id,
    folio: row.folio,
    productName: row.product.name,
    variantName: row.variant?.name ?? null,
    quantity: row.quantity,
    version: row.version,
  };
}

const base = (row: FeedBackorder): BackorderPayloadBase => ({
  backorderId: row.id,
  folio: row.folio,
  productName: row.product.name,
  variantName: row.variant?.name ?? null,
  quantity: row.quantity,
  branchName: row.tenant.name,
  customerFirstName: row.customer.firstName,
  version: row.version,
});

const wrongState = (expected: string): never => {
  throw new Error(`feed backorder: the backorder is not ${expected}`);
};

async function enqueueBackorderItem(
  tx: TenantClient,
  tenantId: string,
  backorderId: string,
  type: string,
  build: (
    row: FeedBackorder,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<boolean> {
  const row = await readBackorder(tx, tenantId, backorderId);
  const payload = await build(row);
  const conversationRef = await saleConversationRef(
    tx,
    tenantId,
    row.customerId,
  );
  const inserted = await insertFeedItems(
    tx,
    tenantId,
    [{ backorderId: row.id, type, conversationRef, payload }],
    { skipDuplicates: true },
  );
  return inserted > 0;
}

/** `backorder.reserved`: call it right after the backorder became RESERVED. */
export function enqueueBackorderReserved(
  tx: TenantClient,
  tenantId: string,
  backorderId: string,
): Promise<boolean> {
  return enqueueBackorderItem(
    tx,
    tenantId,
    backorderId,
    FEED_TYPE.backorderReserved,
    (row) => {
      if (
        row.status !== 'RESERVED' ||
        row.currentPriceCents === null ||
        row.finalPriceCents === null ||
        row.reservedUntil === null ||
        row.reminderAt === null
      ) {
        return wrongState('reserved');
      }
      return buildBackorderReservedPayload({
        ...base(row),
        referencePriceCents: row.referencePriceCents,
        currentPriceCents: row.currentPriceCents,
        finalPriceCents: row.finalPriceCents,
        reservedUntil: row.reservedUntil,
        reminderAt: row.reminderAt,
      });
    },
  );
}

/** `backorder.reservation_reminder`: the sweep's stage 0 → 1 (3 h before the end). */
export function enqueueBackorderReservationReminder(
  tx: TenantClient,
  tenantId: string,
  backorderId: string,
): Promise<boolean> {
  return enqueueBackorderItem(
    tx,
    tenantId,
    backorderId,
    FEED_TYPE.backorderReservationReminder,
    (row) => {
      if (row.status !== 'RESERVED' || row.reservedUntil === null) {
        return wrongState('reserved');
      }
      return buildBackorderReservationReminderPayload({
        ...base(row),
        reservedUntil: row.reservedUntil,
      });
    },
  );
}

/** `backorder.reservation_expired`: call it after RESERVED → EXPIRED. */
export function enqueueBackorderReservationExpired(
  tx: TenantClient,
  tenantId: string,
  backorderId: string,
): Promise<boolean> {
  return enqueueBackorderItem(
    tx,
    tenantId,
    backorderId,
    FEED_TYPE.backorderReservationExpired,
    (row) => {
      if (row.status !== 'EXPIRED' || row.expiredAt === null) {
        return wrongState('expired');
      }
      return {
        ...buildBackorderReservationExpiredPayload({
          ...base(row),
          expiredAt: row.expiredAt,
        }),
        // Additive (T4): the bot reschedules with the same decision.
        sourceDecisionId: row.sourceDecisionId,
      };
    },
  );
}

/**
 * `backorder.cancelled_by_staff` (T5's staff cancel): call it after the
 * backorder became CANCELLED; `reason` is the row's `cancelReason`.
 */
export function enqueueBackorderCancelledByStaff(
  tx: TenantClient,
  tenantId: string,
  backorderId: string,
): Promise<boolean> {
  return enqueueBackorderItem(
    tx,
    tenantId,
    backorderId,
    FEED_TYPE.backorderCancelledByStaff,
    (row) => {
      if (row.status !== 'CANCELLED') return wrongState('cancelled');
      return {
        ...buildBackorderCancelledByStaffPayload({
          ...base(row),
          reason: row.cancelReason,
        }),
        // Additive (T4): the bot reschedules with the same decision.
        sourceDecisionId: row.sourceDecisionId,
      };
    },
  );
}

/**
 * `backorder.eta_updated` (T4): call it after the new `estimatedAt` /
 * `estimatedArrivalDays` were written (and the version bumped).
 */
export function enqueueBackorderEtaUpdated(
  tx: TenantClient,
  tenantId: string,
  backorderId: string,
): Promise<boolean> {
  return enqueueBackorderItem(
    tx,
    tenantId,
    backorderId,
    FEED_TYPE.backorderEtaUpdated,
    (row) =>
      buildBackorderEtaUpdatedPayload({
        ...base(row),
        estimatedAt: row.estimatedAt,
        restockDays: row.estimatedArrivalDays,
      }),
  );
}

/** `backorder.eta_unavailable` (T4): staff have no new estimate. */
export function enqueueBackorderEtaUnavailable(
  tx: TenantClient,
  tenantId: string,
  backorderId: string,
): Promise<boolean> {
  return enqueueBackorderItem(
    tx,
    tenantId,
    backorderId,
    FEED_TYPE.backorderEtaUnavailable,
    (row) => buildBackorderEtaUnavailablePayload(base(row)),
  );
}

/**
 * `backorder.reservation_lost` (Q6): call it after the backorder went back to
 * WAITING (`RESERVATION_LOST` of `revalidateReservation`). `queuePosition` is
 * its 1-based place in the queue of its product/variant right now.
 */
export function enqueueBackorderReservationLost(
  tx: TenantClient,
  tenantId: string,
  backorderId: string,
): Promise<boolean> {
  return enqueueBackorderItem(
    tx,
    tenantId,
    backorderId,
    FEED_TYPE.backorderReservationLost,
    async (row) => {
      if (row.status !== 'WAITING') return wrongState('waiting');
      // Same order as the allocator's queue: (scheduledAt, id).
      const ahead = await tx.backorder.count({
        where: {
          tenantId,
          productId: row.productId,
          variantId: row.variantId,
          status: 'WAITING',
          OR: [
            { scheduledAt: { lt: row.scheduledAt } },
            { scheduledAt: row.scheduledAt, id: { lt: row.id } },
          ],
        },
      });
      return buildBackorderReservationLostPayload({
        ...base(row),
        queuePosition: ahead + 1,
        estimatedAt: row.estimatedAt,
      });
    },
  );
}
