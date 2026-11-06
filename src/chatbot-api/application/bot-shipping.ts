/**
 * shipping-zones / T7 (S8, S10) — the bot `shipping` member of
 * POST /chatbot-api/checkouts (`sale.shipping`) and POST /chatbot-api/sales.
 *
 *   { quoteId }                         — a backend quote, verified at sale time
 *   { mode: "pickup" }                  — store pickup, no address, no charge
 *   { chargeCents, approvalId, quoteId? } — DEPRECATED per-charge approval,
 *                                          kept until the chatbot migrates
 *
 * Shared by both routes so they classify, hash and reject identically.
 * Error bodies carry codes only (never phones or addresses).
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { VerifyQuoteResult } from '../../shipping/quotes/domain/shipping-quote-binding';

export type BotShipping =
  | { kind: 'none' }
  | { kind: 'pickup' }
  | { kind: 'quote'; quoteId: string }
  | {
      kind: 'legacy';
      chargeCents: number;
      approvalId: string;
      quoteId?: string;
    };

type RawShipping =
  | {
      mode?: string;
      quoteId?: string;
      chargeCents?: number;
      approvalId?: string;
    }
  | undefined;

/** The DTO already picked and validated the shape; this only normalizes it. */
export function classifyBotShipping(shipping: RawShipping): BotShipping {
  if (!shipping) return { kind: 'none' };
  if (shipping.mode === 'pickup') return { kind: 'pickup' };
  if (shipping.chargeCents !== undefined || shipping.approvalId !== undefined) {
    return {
      kind: 'legacy',
      chargeCents: shipping.chargeCents as number,
      approvalId: (shipping.approvalId ?? '').trim(),
      ...(shipping.quoteId !== undefined
        ? { quoteId: shipping.quoteId.trim() }
        : {}),
    };
  }
  return { kind: 'quote', quoteId: (shipping.quoteId ?? '').trim() };
}

/**
 * Idempotency-hash member. The legacy member is exactly the pre-T7 one, so
 * receipts written before this change still replay.
 */
export function canonicalShipping(shipping: BotShipping) {
  switch (shipping.kind) {
    case 'none':
      return null;
    case 'pickup':
      return { mode: 'pickup' };
    case 'quote':
      return { quoteId: shipping.quoteId };
    case 'legacy':
      return {
        chargeCents: shipping.chargeCents,
        approvalId: shipping.approvalId,
        quoteId: shipping.quoteId ?? null,
      };
  }
}

const quoteError = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): HttpException =>
  new HttpException(
    { statusCode: status, error: code, message: code, ...extra },
    status,
  );

/** Verifier outcome → HTTP error, or null when the quote is usable. */
export function quoteRejection(
  result: VerifyQuoteResult,
): HttpException | null {
  switch (result.status) {
    case 'OK':
      return null;
    case 'NOT_FOUND':
      return quoteError(HttpStatus.NOT_FOUND, 'SHIPPING_QUOTE_NOT_FOUND');
    case 'EXPIRED':
      return quoteError(HttpStatus.CONFLICT, 'SHIPPING_QUOTE_EXPIRED');
    case 'MISMATCH':
      return quoteError(HttpStatus.CONFLICT, 'SHIPPING_QUOTE_MISMATCH', {
        mismatches: result.mismatches,
      });
  }
}

const SALE_TIME_QUOTE_ERRORS: Record<string, number> = {
  SHIPPING_QUOTE_ALREADY_USED: HttpStatus.CONFLICT,
  // T8 — expired while the sale waited for the quote row lock.
  SHIPPING_QUOTE_EXPIRED: HttpStatus.CONFLICT,
  SHIPPING_QUOTE_NOT_FOUND: HttpStatus.NOT_FOUND,
};

/** `confirmBotSale` quote failures (domain errors) → HTTP, else null. */
export function shippingQuoteHttpError(error: unknown): HttpException | null {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
  if (typeof code !== 'string' || !(code in SALE_TIME_QUOTE_ERRORS)) {
    return null;
  }
  return quoteError(SALE_TIME_QUOTE_ERRORS[code], code);
}
