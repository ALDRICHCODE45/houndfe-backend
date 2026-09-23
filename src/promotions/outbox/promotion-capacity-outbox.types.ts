/** Frozen `promotion.near_capacity.detected` outbox contract (pca-3b3a). */
import type { Prisma } from '@prisma/client';

/** Outbox `eventType` emitted by the promotion-capacity outbox writer. */
export const PROMOTION_NEAR_CAPACITY_EVENT_TYPE =
  'promotion.near_capacity.detected';
/** Inngest event name this dispatcher sends (consumer contract: pca-3b4). */
export const PROMOTION_NEAR_CAPACITY_INNGEST_EVENT =
  'promotion/near-capacity.detected';
/** Immutable payload written by the transactional outbox writer. */
export interface PromotionCapacityOutboxPayload {
  tenantId: string;
  promotionId: string;
  saleId: string;
  previousConsumedProductUnits: number;
  consumedProductUnits: number;
  maxProductUnits: number;
  occurredAt: string;
}
/** Ledger identity (`tenantId`+`promotionId`+`saleId`), all fields non-empty. */
export type PromotionCapacityIdentity = Pick<
  PromotionCapacityOutboxPayload,
  'tenantId' | 'promotionId' | 'saleId'
>;

/** Narrows the raw `Json` payload to the ledger identity, or `null` if unusable. */
export function readPromotionCapacityIdentity(
  payload: Prisma.JsonValue,
): PromotionCapacityIdentity | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    'toJSON' in payload ||
    !('tenantId' in payload) ||
    !('promotionId' in payload) ||
    !('saleId' in payload)
  ) {
    return null;
  }
  const { tenantId, promotionId, saleId } = payload;
  if (
    typeof tenantId !== 'string' ||
    typeof promotionId !== 'string' ||
    typeof saleId !== 'string' ||
    !tenantId ||
    !promotionId ||
    !saleId
  ) {
    return null;
  }
  return { tenantId, promotionId, saleId };
}
