/**
 * Per-tenant backorder folio: `BO-000001`. The number is a tenant counter
 * incremented atomically inside the creating transaction (see
 * `infrastructure/backorder-folio.allocator.ts`), the same pattern as the cash
 * closing folio `CC-000001`.
 */
export const BACKORDER_FOLIO_PATTERN = /^BO-[0-9]{6,}$/;

/** `BO-` plus the number zero padded to 6 digits; wider numbers are not truncated. */
export function formatBackorderFolio(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('Backorder folio sequence must be a positive integer');
  }
  return `BO-${String(sequence).padStart(6, '0')}`;
}
