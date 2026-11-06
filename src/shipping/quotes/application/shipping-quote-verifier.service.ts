/**
 * shipping-zones / T3 (S8) — checkout entry point (wired by a later task).
 *
 * Loads the quote by the hash of its opaque id, inside the given tenant, and
 * applies the pure `verifyShippingQuote` rules. The checkout maps the result
 * to SHIPPING_QUOTE_NOT_FOUND / SHIPPING_QUOTE_EXPIRED / SHIPPING_QUOTE_MISMATCH
 * or fixes `quote.customerChargeCents` as the sale shipping charge.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  hashQuoteToken,
  verifyShippingQuote,
  type VerifyQuoteRequest,
  type VerifyQuoteResult,
} from '../domain/shipping-quote-binding';
import {
  SHIPPING_QUOTE_REPOSITORY,
  type IShippingQuoteRepository,
} from '../domain/shipping-quote.repository';

const QUOTE_TOKEN = /^shq_[A-Za-z0-9_-]{43}$/;

@Injectable()
export class ShippingQuoteVerifier {
  constructor(
    @Inject(SHIPPING_QUOTE_REPOSITORY)
    private readonly quotes: IShippingQuoteRepository,
  ) {}

  async verify(
    quoteId: string,
    request: VerifyQuoteRequest,
    now: Date = new Date(),
  ): Promise<VerifyQuoteResult> {
    if (!QUOTE_TOKEN.test(quoteId)) return { status: 'NOT_FOUND' };
    const stored = await this.quotes.findByTokenHash(
      request.tenantId,
      hashQuoteToken(quoteId),
    );
    return verifyShippingQuote(stored, request, now);
  }
}
