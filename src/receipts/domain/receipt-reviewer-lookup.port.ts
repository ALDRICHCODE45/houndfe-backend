/**
 * Resolves which of the configured notification recipients may review
 * receipts in the current tenant (CLS-scoped). A reviewer is an active
 * member whose role grants update or manage on ReceiptEvidence, or
 * manage on all. Returns deduped emails; never throws on an empty list.
 */
export interface IReceiptReviewerLookup {
  resolveReviewerEmails(userIds: string[]): Promise<string[]>;
}

export const RECEIPT_REVIEWER_LOOKUP = Symbol.for('ReceiptReviewerLookup');
