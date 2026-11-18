import type { DestinationCheck } from './receipt-destination-check';

/**
 * Mismatch snapshot computed at upload against the sale debt, which is the
 * source of truth. Diffs are signed `amount - debt`: negative means a partial
 * payment, positive an overpayment. A diff is present only when its amount was
 * provided. `flagged` is true when any provided amount differs from the debt.
 * It is a review hint only; a human always confirms the paid amount.
 *
 * `destinationCheck` (N18) is stored here too, but only when the extraction
 * carried a destination last4 or name; absent means 'unknown'. It never
 * affects `flagged`, which stays about the amount only.
 */
export type ReceiptMismatch = {
  debtCents: number;
  declaredDiffCents?: number;
  extractedDiffCents?: number;
  flagged: boolean;
  destinationCheck?: DestinationCheck;
};

export function computeReceiptMismatch(input: {
  debtCents: number;
  declared: number | null;
  extracted: number | null;
}): ReceiptMismatch {
  const mismatch: ReceiptMismatch = {
    debtCents: input.debtCents,
    flagged: false,
  };
  if (input.declared !== null) {
    mismatch.declaredDiffCents = input.declared - input.debtCents;
  }
  if (input.extracted !== null) {
    mismatch.extractedDiffCents = input.extracted - input.debtCents;
  }
  mismatch.flagged =
    (mismatch.declaredDiffCents ?? 0) !== 0 ||
    (mismatch.extractedDiffCents ?? 0) !== 0;
  return mismatch;
}
