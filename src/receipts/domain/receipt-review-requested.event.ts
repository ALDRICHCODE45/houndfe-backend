/**
 * Outbox contract of the RECEIPT_REVIEW_REQUESTED staff email.
 *
 * Written in the same transaction as a NEW receipt (never on an idempotent
 * replay) when the tenant enabled the action. The payload is self-contained
 * so the dispatcher and the Inngest function never re-read the sale; it
 * carries no storage key and no file reference (the email never attaches or
 * links the file itself). It carries no customer name or phone either (R10,
 * contract §6.3): the email shows the order folio only.
 */
export const RECEIPT_REVIEW_REQUESTED_EVENT_TYPE = 'receipt.review_requested';

/** Inngest event the dedicated dispatcher sends. */
export const RECEIPT_REVIEW_REQUESTED_INNGEST_EVENT =
  'receipts/review.requested';

export type ReceiptReviewRequestedPayload = {
  tenantId: string;
  receiptId: string;
  saleId: string;
  saleFolio: string | null;
  declaredAmountCents: number | null;
  extractedAmountCents: number | null;
  /** Sale debt when the receipt arrived. */
  debtCents: number;
  mismatchFlagged: boolean;
  /** null for legacy mediaUrl attachments. */
  mimeType: string | null;
};
