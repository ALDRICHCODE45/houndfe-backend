/** Frozen `promotion.expiring.detected` outbox contract (pca-3c1a). */
import type { Prisma } from '@prisma/client';

/** Outbox `eventType` emitted by the promotion-expiry claim repository. */
export const PROMOTION_EXPIRING_EVENT_TYPE = 'promotion.expiring.detected';
/** Inngest event name this event is dispatched as (consumer: pca-3c4). */
export const PROMOTION_EXPIRING_INNGEST_EVENT = 'promotion/expiring.detected';

/**
 * Immutable payload written by the transactional outbox writer. Consumers
 * never enrich or rewrite it.
 *
 * `endDateFingerprint` is the effective end date itself
 * (`endDate.toISOString()`, never a hash) and is the dedupe identity: one
 * alert per promotion per effective end date, so A → B → A alerts once.
 * `endDate` repeats the same ISO instant as the human-readable date the
 * digest renders. `occurredAt` is the claim transaction's read instant.
 */
export interface PromotionExpiryOutboxPayload {
  tenantId: string;
  promotionId: string;
  endDate: string;
  endDateFingerprint: string;
  occurredAt: string;
}

/** Alert identity (`tenantId`+`promotionId`+`endDateFingerprint`), all non-empty. */
export type PromotionExpiryIdentity = Pick<
  PromotionExpiryOutboxPayload,
  'tenantId' | 'promotionId' | 'endDateFingerprint'
>;

/** Narrows the raw `Json` payload to the alert identity, or `null` if unusable. */
export function readPromotionExpiryIdentity(
  payload: Prisma.JsonValue,
): PromotionExpiryIdentity | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    'toJSON' in payload ||
    !('tenantId' in payload) ||
    !('promotionId' in payload) ||
    !('endDateFingerprint' in payload)
  ) {
    return null;
  }
  const { tenantId, promotionId, endDateFingerprint } = payload;
  if (
    typeof tenantId !== 'string' ||
    typeof promotionId !== 'string' ||
    typeof endDateFingerprint !== 'string' ||
    !tenantId ||
    !promotionId ||
    !endDateFingerprint
  ) {
    return null;
  }
  return { tenantId, promotionId, endDateFingerprint };
}
