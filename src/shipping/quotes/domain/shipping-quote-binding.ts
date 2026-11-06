/**
 * shipping-zones / T3 (S8) — quote binding, expiry and opaque ids.
 *
 * A quote is bound to the sucursal, the customer (phone identity, as in
 * `pricing/evaluate-cart`), the cart lines (product, variant, quantity) and
 * the destination place (zipCode, state, municipality, neighborhood). The
 * checkout task calls `verifyShippingQuote` with what it is about to sell:
 *
 *   1. NOT_FOUND — no stored quote for that id, or it belongs to another
 *      sucursal (indistinguishable on purpose).
 *   2. EXPIRED   — now ≥ expiresAt. Checked before the binding, so an expired
 *      quote is dead whatever the request says (the bot requotes silently).
 *   3. MISMATCH  — the customer, the lines or the destination differ; every
 *      differing part is listed.
 *   4. OK        — with the stored charge to fix on the sale.
 *
 * Comparison rules (pure, no clock or database here):
 *   - customer: digits of phoneCountryCode and phone;
 *   - lines: the same multiset of (productId, variantId|null, quantity),
 *     order ignored;
 *   - destination: the 5-digit zipCode exactly; place labels compared after
 *     trimming, collapsing whitespace, removing accents and lower-casing, a
 *     blank label counting as null. A saved address and loose fields bind the
 *     same way, so a quote made with loose fields matches the address the
 *     checkout saves with those fields.
 *
 * The quote id is `shq_` + 32 random bytes (base64url). Only its SHA-256 is
 * stored, so the database alone cannot replay a quote.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface QuoteLineInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export interface QuoteLine {
  productId: string;
  variantId: string | null;
  quantity: number;
}

export interface QuoteDestinationInput {
  zipCode: string;
  state?: string | null;
  municipality?: string | null;
  neighborhood?: string | null;
}

export interface QuoteDestination {
  zipCode: string;
  state: string | null;
  municipality: string | null;
  neighborhood: string | null;
}

export interface StoredQuoteBinding {
  id: string;
  tenantId: string;
  phoneCountryCode: string;
  phone: string;
  lines: QuoteLine[];
  destination: QuoteDestination;
  costCents: number;
  creditCents: number;
  customerChargeCents: number;
  currency: string;
  expiresAt: Date;
}

export interface VerifyQuoteRequest {
  tenantId: string;
  customer: { phoneCountryCode: string; phone: string };
  lines: QuoteLineInput[];
  destination: QuoteDestinationInput;
}

export type QuoteMismatch = 'CUSTOMER' | 'LINES' | 'DESTINATION';

export type VerifyQuoteResult =
  | { status: 'NOT_FOUND' }
  | { status: 'EXPIRED' }
  | { status: 'MISMATCH'; mismatches: QuoteMismatch[] }
  | {
      status: 'OK';
      quote: Pick<
        StoredQuoteBinding,
        | 'id'
        | 'costCents'
        | 'creditCents'
        | 'customerChargeCents'
        | 'currency'
        | 'expiresAt'
      >;
    };

export const normalizePhoneDigits = (value: string): string =>
  value.replace(/\D/g, '');

const normalizeLabel = (value: string | null | undefined): string | null => {
  const normalized = (value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized === '' ? null : normalized;
};

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export function normalizeLines(lines: readonly QuoteLineInput[]): QuoteLine[] {
  return lines
    .map((line) => ({
      productId: line.productId,
      variantId: line.variantId ?? null,
      quantity: line.quantity,
    }))
    .sort(
      (a, b) =>
        compareText(a.productId, b.productId) ||
        compareText(a.variantId ?? '', b.variantId ?? '') ||
        a.quantity - b.quantity,
    );
}

/** Stored as given (trimmed); `verifyShippingQuote` compares normalized. */
export function normalizeDestination(
  destination: QuoteDestinationInput,
): QuoteDestination {
  const trimmed = (value: string | null | undefined): string | null =>
    value?.trim() || null;
  return {
    zipCode: destination.zipCode.trim(),
    state: trimmed(destination.state),
    municipality: trimmed(destination.municipality),
    neighborhood: trimmed(destination.neighborhood),
  };
}

const linesKey = (lines: readonly QuoteLineInput[]): string =>
  JSON.stringify(
    normalizeLines(lines).map((l) => [l.productId, l.variantId, l.quantity]),
  );

const destinationKey = (destination: QuoteDestinationInput): string =>
  JSON.stringify([
    destination.zipCode.trim(),
    normalizeLabel(destination.state),
    normalizeLabel(destination.municipality),
    normalizeLabel(destination.neighborhood),
  ]);

export function verifyShippingQuote(
  stored: StoredQuoteBinding | null,
  request: VerifyQuoteRequest,
  now: Date,
): VerifyQuoteResult {
  if (!stored || stored.tenantId !== request.tenantId) {
    return { status: 'NOT_FOUND' };
  }
  if (now.getTime() >= stored.expiresAt.getTime()) {
    return { status: 'EXPIRED' };
  }
  const mismatches: QuoteMismatch[] = [];
  if (
    normalizePhoneDigits(stored.phoneCountryCode) !==
      normalizePhoneDigits(request.customer.phoneCountryCode) ||
    normalizePhoneDigits(stored.phone) !==
      normalizePhoneDigits(request.customer.phone)
  ) {
    mismatches.push('CUSTOMER');
  }
  if (linesKey(stored.lines) !== linesKey(request.lines)) {
    mismatches.push('LINES');
  }
  if (
    destinationKey(stored.destination) !== destinationKey(request.destination)
  ) {
    mismatches.push('DESTINATION');
  }
  if (mismatches.length > 0) return { status: 'MISMATCH', mismatches };
  return {
    status: 'OK',
    quote: {
      id: stored.id,
      costCents: stored.costCents,
      creditCents: stored.creditCents,
      customerChargeCents: stored.customerChargeCents,
      currency: stored.currency,
      expiresAt: stored.expiresAt,
    },
  };
}

/** now + TTL, never beyond the carrier rate validity. */
export function computeQuoteExpiry(
  now: Date,
  ttlMinutes: number,
  carrierValidUntil: Date | null,
): Date {
  const ttlEnd = now.getTime() + ttlMinutes * 60_000;
  return new Date(
    carrierValidUntil ? Math.min(ttlEnd, carrierValidUntil.getTime()) : ttlEnd,
  );
}

export function generateQuoteToken(): string {
  return `shq_${randomBytes(32).toString('base64url')}`;
}

export function hashQuoteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
