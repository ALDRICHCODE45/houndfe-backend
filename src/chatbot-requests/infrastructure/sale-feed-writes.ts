/**
 * pay-in-store-pickup / T3 (S2, S3, S6) — the sale-level items of the bot
 * feed: `sale.pickup_reminder`, `sale.pickup_expired`, `sale.pickup_extended`.
 *
 * Always on the caller's transaction (the hold change and its item commit or
 * roll back together) through `insertFeedItems`, so they share the feed's
 * per-tenant advisory lock (cursor order is commit order) and its `NOTIFY`.
 * Lock order: the caller already holds the sale row (`FOR UPDATE`) and takes
 * the feed lock after it, the same order as a receipt confirmation (sale
 * payment, then the request's feed item); nothing takes a sale row while
 * holding the feed lock.
 *
 * Exactly once per (sale, type, holdVersion): the partial unique index
 * `chatbot_feed_items_sale_hold_uq` (migration 20261118020000) with
 * `ON CONFLICT DO NOTHING`, so a retry, a second sweep replica or a repeated
 * call is a no-op (`false`).
 */
import { canonicalPhone } from '../domain/canonical-phone';
import {
  buildPickupExpiredPayload,
  buildPickupExtendedPayload,
  buildPickupReminderPayload,
  FEED_TYPE,
} from '../domain/chatbot-feed';
import { insertFeedItems } from './chatbot-feed-writes';
import type { TenantClient } from './chatbot-request-writes';
import { customerConversation } from './chatbot-request-wrapper';

/** What an enqueue needs of the sale (the caller has it under its row lock). */
export interface PickupFeedSale {
  id: string;
  folio: string | null;
  holdExpiresAt: Date | null;
  customerId: string | null;
}

/**
 * The customer's mirrored chat, resolved like the receipt wrapper does: the
 * one `chatbot_conversations` row of the tenant whose `customerKey` is the
 * canonical key of the sale customer's phone. No customer, no phone, no chat
 * or several chats: `null` (the bot then maps `saleId` to its own checkout
 * conversation, or ACKs `STALE`).
 */
export async function saleConversationRef(
  tx: TenantClient,
  tenantId: string,
  customerId: string | null,
): Promise<string | null> {
  if (!customerId) return null;
  const customer = await tx.customer.findFirst({
    where: { tenantId, id: customerId },
    select: { phoneCountryCode: true, phone: true },
  });
  if (!customer?.phoneCountryCode || !customer.phone) return null;
  const key = canonicalPhone(customer.phoneCountryCode, customer.phone);
  if (!key) return null;
  const chat = await customerConversation(tx, tenantId, key);
  return chat?.conversationRef ?? null;
}

const missingDeadline = (): never => {
  throw new Error('feed pickup: the sale has no hold deadline');
};

async function enqueueSaleItem(
  tx: TenantClient,
  tenantId: string,
  sale: PickupFeedSale,
  type: string,
  build: (conversationRef: string | null) => Record<string, unknown>,
): Promise<boolean> {
  const conversationRef = await saleConversationRef(
    tx,
    tenantId,
    sale.customerId,
  );
  const inserted = await insertFeedItems(
    tx,
    tenantId,
    [
      {
        saleId: sale.id,
        type,
        conversationRef,
        payload: build(conversationRef),
      },
    ],
    { skipDuplicates: true },
  );
  return inserted > 0;
}

/** `sale.pickup_reminder` (S3): the T2 sweep's reminder stage. */
export function enqueuePickupReminder(
  tx: TenantClient,
  tenantId: string,
  sale: PickupFeedSale,
  holdVersion: number,
): Promise<boolean> {
  const holdUntil = sale.holdExpiresAt ?? missingDeadline();
  return enqueueSaleItem(
    tx,
    tenantId,
    sale,
    FEED_TYPE.pickupReminder,
    (conversationRef) =>
      buildPickupReminderPayload({
        saleId: sale.id,
        folio: sale.folio,
        holdUntil,
        holdVersion,
        conversationRef,
      }),
  );
}

/** `sale.pickup_expired` (S2): the T2 sweep cancelled the unpaid sale. */
export function enqueuePickupExpired(
  tx: TenantClient,
  tenantId: string,
  sale: PickupFeedSale,
  holdVersion: number,
): Promise<boolean> {
  return enqueueSaleItem(
    tx,
    tenantId,
    sale,
    FEED_TYPE.pickupExpired,
    (conversationRef) =>
      buildPickupExpiredPayload({
        saleId: sale.id,
        folio: sale.folio,
        holdVersion,
        conversationRef,
      }),
  );
}

/** `sale.pickup_extended` (S5, informational): staff moved the deadline. */
export function enqueuePickupExtended(
  tx: TenantClient,
  tenantId: string,
  sale: PickupFeedSale,
  holdVersion: number,
): Promise<boolean> {
  const holdUntil = sale.holdExpiresAt ?? missingDeadline();
  return enqueueSaleItem(
    tx,
    tenantId,
    sale,
    FEED_TYPE.pickupExtended,
    (conversationRef) =>
      buildPickupExtendedPayload({
        saleId: sale.id,
        folio: sale.folio,
        holdUntil,
        holdVersion,
        conversationRef,
      }),
  );
}
