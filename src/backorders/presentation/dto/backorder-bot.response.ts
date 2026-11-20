/**
 * `BackorderBot` (contract v1 §6.5): the bot-facing projection of a backorder.
 *
 * Timestamps are ISO 8601 UTC (`toISOString()`, `…Z`), like every other bot
 * payload today (`holdUntil`, feed items). Decided: UTC `Z` everywhere, no
 * local offset (restock-backorder L4).
 */
import type {
  BackorderCancelledByKindValue,
  BackorderStatusValue,
} from '../../domain/backorder-status';

/** The row plus the names the bot shows (joined at read time). */
export interface BackorderBotSource {
  id: string;
  folio: string;
  status: BackorderStatusValue;
  productId: string;
  variantId: string | null;
  quantity: number;
  referencePriceCents: number;
  currentPriceCents: number | null;
  finalPriceCents: number | null;
  scheduledAt: Date;
  estimatedAt: Date;
  estimatedArrivalDays: number;
  reservedAt: Date | null;
  reservedUntil: Date | null;
  reminderAt: Date | null;
  saleId: string | null;
  sourceDecisionId: string;
  cancelledByKind: BackorderCancelledByKindValue | null;
  cancelReason: string | null;
  product: { name: string };
  variant: { name: string } | null;
  customer: {
    firstName: string;
    phoneCountryCode: string | null;
    phone: string | null;
  };
  tenant: { name: string };
}

export interface BackorderBot {
  id: string;
  folio: string;
  status: BackorderStatusValue;
  productId: string;
  productName: string;
  variantId: string | null;
  variantName: string | null;
  quantity: number;
  referencePriceCents: number;
  currentPriceCents: number | null;
  finalPriceCents: number | null;
  scheduledAt: string;
  estimatedAt: string;
  estimatedArrivalDays: number;
  reservedAt: string | null;
  reservedUntil: string | null;
  reminderAt: string | null;
  /** 1-based, only while `WAITING`. */
  queuePosition: number | null;
  saleId: string | null;
  /**
   * The RESTOCK decision this backorder was scheduled from. After `EXPIRED` /
   * `CANCELLED` the bot reschedules by repeating `POST /chatbot-api/backorders`
   * with the same `sourceDecisionId` (contract §6.1).
   */
  sourceDecisionId: string;
  cancelledByKind: BackorderCancelledByKindValue | null;
  cancelReason: string | null;
  branchName: string;
  customerFirstName: string;
  /**
   * The customer's phone (the key of the checkout phone lock); `null` when the
   * customer has none. Additive, only on routes the credential reaches with
   * `backorders:*` and only for that customer's own backorder.
   */
  phoneCountryCode: string | null;
  phone: string | null;
}

export interface BackorderBotEnvelope {
  backorder: BackorderBot;
}

export interface BackorderBotListEnvelope {
  items: BackorderBot[];
  /**
   * Only on a recovery read (`updatedSince`): the feed `after` that serves the
   * oldest unacknowledged `backorder.*` item again (restock-backorder T2b), or
   * `null` when none is pending.
   */
  backorderUndeliveredResumeAfter?: string | null;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function toBackorderBot(
  source: BackorderBotSource,
  queuePosition: number | null,
): BackorderBot {
  return {
    id: source.id,
    folio: source.folio,
    status: source.status,
    productId: source.productId,
    productName: source.product.name,
    variantId: source.variantId,
    variantName: source.variant?.name ?? null,
    quantity: source.quantity,
    referencePriceCents: source.referencePriceCents,
    currentPriceCents: source.currentPriceCents,
    finalPriceCents: source.finalPriceCents,
    scheduledAt: source.scheduledAt.toISOString(),
    estimatedAt: source.estimatedAt.toISOString(),
    estimatedArrivalDays: source.estimatedArrivalDays,
    reservedAt: iso(source.reservedAt),
    reservedUntil: iso(source.reservedUntil),
    reminderAt: iso(source.reminderAt),
    queuePosition: source.status === 'WAITING' ? queuePosition : null,
    saleId: source.saleId,
    sourceDecisionId: source.sourceDecisionId,
    cancelledByKind: source.cancelledByKind,
    cancelReason: source.cancelReason,
    branchName: source.tenant.name,
    customerFirstName: source.customer.firstName,
    phoneCountryCode: source.customer.phoneCountryCode,
    phone: source.customer.phone,
  };
}
