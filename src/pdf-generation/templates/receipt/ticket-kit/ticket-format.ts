/**
 * Ticket kit — text helpers. Money and dates come from the A4 kit
 * (`formatA4Money`, `formatA4DateTime`, `formatA4Time`); only ticket-specific
 * wording lives here.
 */

/** Spanish long form of the base payment-method codes. */
const METHOD_LABELS: Readonly<Record<string, string>> = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  TRANSFER: 'Transferencia',
  CHECK: 'Cheque',
  CREDIT: 'Crédito',
};

/** Humanize a payment-method code; unknown codes are printed as-is. */
export function formatTicketMethod(method: string): string {
  return METHOD_LABELS[method.toUpperCase()] ?? method;
}

/**
 * Quantity as a trimmed string: `2`, `2.5`, `1.5` (never `2.00`).
 * Fractional units (kg, m) keep up to two decimals.
 */
export function formatTicketQuantity(quantity: number): string {
  if (Number.isInteger(quantity)) {
    return quantity.toString();
  }
  return quantity.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Chunk size between break points inside a long unbroken token
 * (12 × ~6 pt bold ≈ 72 pt, so a 203 pt line always has several).
 */
const MAX_UNBROKEN_RUN = 12;
const SOFT_HYPHEN = '\u00AD';

/**
 * Give react-pdf a legal break point inside absurdly long unbroken tokens
 * (a 40+ character SKU, a hyphen-joined code or repeated letters has no
 * syllable to hyphenate at and would overflow into the amount column). Soft
 * hyphens are invisible unless the line actually breaks there; ordinary words
 * (under 18 characters) are returned unchanged.
 */
export function softBreakLongTokens(value: string): string {
  return value.replace(/[^\s\u00AD]{18,}/g, (token) => {
    const parts: string[] = [];
    for (let i = 0; i < token.length; i += MAX_UNBROKEN_RUN) {
      parts.push(token.slice(i, i + MAX_UNBROKEN_RUN));
    }
    return parts.join(SOFT_HYPHEN);
  });
}
