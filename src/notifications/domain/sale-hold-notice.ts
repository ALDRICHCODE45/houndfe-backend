/**
 * pay-in-store-pickup / T2 (S4) — the staff notice of a pay-in-store hold
 * that reached its deadline with a payment or a pending receipt: the sale is
 * NOT cancelled and staff decide (and refund if needed).
 *
 * It rides the request-notice pipeline: the producer writes the same
 * `chatbot_request.notify` outbox row (on the sweep's transaction) and the
 * dedicated consumer turns it into in-app notifications + realtime events. It
 * is a SALE notice, not a request one: `requestId` stays null on the
 * notification, the payload names the sale, and it sends no email (in-app
 * only). Recipients: every active member with `update:Sale` (the grant that
 * charges a bot sale at the counter and edits the hold). Small payload, no
 * customer data (§6.3).
 */
export const SALE_HOLD_REVIEW_NOTICE = 'SALE_HOLD_REVIEW';

/** Why the hold was not cancelled (S4). */
export type SaleHoldReviewReason = 'PAYMENT_RECEIVED' | 'RECEIPT_PENDING';

const REASONS: readonly SaleHoldReviewReason[] = [
  'PAYMENT_RECEIVED',
  'RECEIPT_PENDING',
];

/** Grants of the recipients, as `[action, subject]` pairs (all of them). */
export const SALE_HOLD_REVIEW_GRANTS: ReadonlyArray<readonly [string, string]> =
  [['update', 'Sale']];

/** What the producer writes (outbox payload). */
export interface SaleHoldReviewNotice {
  type: typeof SALE_HOLD_REVIEW_NOTICE;
  saleId: string;
  saleFolio: string | null;
  holdVersion: number;
  reason: SaleHoldReviewReason;
  /** One notice per sale and hold version, per recipient. */
  dedupKey: string;
}

export const saleHoldReviewDedupKey = (saleId: string, holdVersion: number) =>
  `hold-review:${saleId}:${holdVersion}`;

/** `payload` of the in-app notification. */
export interface SaleHoldReviewPayload {
  saleId: string;
  saleFolio: string | null;
  reason: SaleHoldReviewReason;
}

export const isSaleHoldReviewReason = (
  value: unknown,
): value is SaleHoldReviewReason =>
  (REASONS as readonly unknown[]).includes(value);

/** The outbox payload when it is a sale-hold notice, else `null`. */
export function asSaleHoldReviewNotice(
  payload: unknown,
): SaleHoldReviewNotice | null {
  const notice = payload as Partial<SaleHoldReviewNotice> | null;
  if (!notice || notice.type !== SALE_HOLD_REVIEW_NOTICE) return null;
  if (
    typeof notice.saleId !== 'string' ||
    (notice.saleFolio !== null && typeof notice.saleFolio !== 'string') ||
    typeof notice.holdVersion !== 'number' ||
    !isSaleHoldReviewReason(notice.reason) ||
    typeof notice.dedupKey !== 'string'
  ) {
    throw new Error('malformed sale hold review notice payload');
  }
  return notice as SaleHoldReviewNotice;
}

const REASON_TEXT: Record<SaleHoldReviewReason, string> = {
  PAYMENT_RECEIVED: 'Tiene un pago registrado',
  RECEIPT_PENDING: 'Comprobante pendiente de revisar',
};

/** §5.2 `title` / `body` of the in-app notice. */
export function saleHoldReviewText(payload: Partial<SaleHoldReviewPayload>): {
  title: string;
  body: string;
} {
  const parts = [
    typeof payload.saleFolio === 'string' ? `Venta ${payload.saleFolio}` : null,
    isSaleHoldReviewReason(payload.reason) ? REASON_TEXT[payload.reason] : null,
  ].filter((part): part is string => part !== null);
  return {
    title: 'Apartado vencido: revisa la venta',
    body: parts.join(' · '),
  };
}
