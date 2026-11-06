// shipping-zones / T7 (S8, S10) — bot shipping shape helpers.
import { HttpException } from '@nestjs/common';
import {
  canonicalShipping,
  classifyBotShipping,
  quoteRejection,
  shippingQuoteHttpError,
} from './bot-shipping';

const QUOTE = `shq_${'A'.repeat(43)}`;

describe('classifyBotShipping', () => {
  it.each([
    [undefined, { kind: 'none' }],
    [{ mode: 'pickup' }, { kind: 'pickup' }],
    [{ quoteId: ` ${QUOTE} ` }, { kind: 'quote', quoteId: QUOTE }],
    [
      { chargeCents: 500, approvalId: ' a-1 ', quoteId: ' q ' },
      { kind: 'legacy', chargeCents: 500, approvalId: 'a-1', quoteId: 'q' },
    ],
    [
      { chargeCents: 500, approvalId: 'a-1' },
      { kind: 'legacy', chargeCents: 500, approvalId: 'a-1' },
    ],
  ])('classifies %j', (shipping, expected) => {
    expect(classifyBotShipping(shipping)).toEqual(expected);
  });
});

describe('canonicalShipping', () => {
  it('keeps the pre-T7 legacy hash member byte-for-byte', () => {
    expect(
      canonicalShipping({
        kind: 'legacy',
        chargeCents: 500,
        approvalId: 'a-1',
      }),
    ).toEqual({ chargeCents: 500, approvalId: 'a-1', quoteId: null });
  });

  it('distinguishes quote and pickup and returns null for none', () => {
    expect(canonicalShipping({ kind: 'quote', quoteId: QUOTE })).toEqual({
      quoteId: QUOTE,
    });
    expect(canonicalShipping({ kind: 'pickup' })).toEqual({ mode: 'pickup' });
    expect(canonicalShipping({ kind: 'none' })).toBeNull();
  });
});

describe('quoteRejection', () => {
  const body = (error: HttpException) => ({
    status: error.getStatus(),
    body: error.getResponse(),
  });

  it('maps NOT_FOUND to 404 and EXPIRED to 409', () => {
    expect(body(quoteRejection({ status: 'NOT_FOUND' })!)).toEqual({
      status: 404,
      body: {
        statusCode: 404,
        error: 'SHIPPING_QUOTE_NOT_FOUND',
        message: 'SHIPPING_QUOTE_NOT_FOUND',
      },
    });
    expect(body(quoteRejection({ status: 'EXPIRED' })!).status).toBe(409);
  });

  it('maps MISMATCH to 409 listing every mismatched part', () => {
    expect(
      body(
        quoteRejection({
          status: 'MISMATCH',
          mismatches: ['LINES', 'DESTINATION'],
        })!,
      ),
    ).toEqual({
      status: 409,
      body: {
        statusCode: 409,
        error: 'SHIPPING_QUOTE_MISMATCH',
        message: 'SHIPPING_QUOTE_MISMATCH',
        mismatches: ['LINES', 'DESTINATION'],
      },
    });
  });

  it('returns null for OK', () => {
    expect(
      quoteRejection({
        status: 'OK',
        quote: {
          id: 'row',
          costCents: 0,
          creditCents: 0,
          customerChargeCents: 0,
          currency: 'MXN',
          expiresAt: new Date(),
        },
      }),
    ).toBeNull();
  });
});

describe('shippingQuoteHttpError', () => {
  it('maps the sale-time quote codes and ignores other errors', () => {
    expect(
      shippingQuoteHttpError({
        code: 'SHIPPING_QUOTE_ALREADY_USED',
      })?.getStatus(),
    ).toBe(409);
    expect(
      shippingQuoteHttpError({ code: 'SHIPPING_QUOTE_NOT_FOUND' })?.getStatus(),
    ).toBe(404);
    expect(
      shippingQuoteHttpError({ code: 'SHIPPING_QUOTE_EXPIRED' })?.getResponse(),
    ).toMatchObject({ statusCode: 409, error: 'SHIPPING_QUOTE_EXPIRED' });
    expect(shippingQuoteHttpError({ code: 'PRICE_OUT_OF_DATE' })).toBeNull();
    expect(shippingQuoteHttpError(new Error('x'))).toBeNull();
  });
});
