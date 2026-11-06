import {
  computeQuoteExpiry,
  generateQuoteToken,
  hashQuoteToken,
  normalizeDestination,
  normalizeLines,
  verifyShippingQuote,
  type StoredQuoteBinding,
} from './shipping-quote-binding';

const NOW = new Date('2026-11-05T12:00:00.000Z');

const stored: StoredQuoteBinding = {
  id: 'q-1',
  tenantId: 't-1',
  phoneCountryCode: '52',
  phone: '5512345678',
  lines: normalizeLines([
    { productId: 'p-2', variantId: null, quantity: 1 },
    { productId: 'p-1', variantId: 'v-1', quantity: 2 },
  ]),
  destination: normalizeDestination({
    zipCode: '06700',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
  }),
  costCents: 30000,
  creditCents: 12000,
  customerChargeCents: 18000,
  currency: 'MXN',
  expiresAt: new Date('2026-11-05T12:30:00.000Z'),
};

const request = {
  tenantId: 't-1',
  customer: { phoneCountryCode: '52', phone: '5512345678' },
  lines: [
    { productId: 'p-1', variantId: 'v-1', quantity: 2 },
    { productId: 'p-2', quantity: 1 },
  ],
  destination: {
    zipCode: '06700',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
  },
};

describe('verifyShippingQuote (S8 binding)', () => {
  it('returns OK with the stored charge for the same binding, in any line order', () => {
    expect(verifyShippingQuote(stored, request, NOW)).toEqual({
      status: 'OK',
      quote: {
        id: 'q-1',
        costCents: 30000,
        creditCents: 12000,
        customerChargeCents: 18000,
        currency: 'MXN',
        expiresAt: stored.expiresAt,
      },
    });
  });

  it('is NOT_FOUND for an unknown or foreign quote', () => {
    expect(verifyShippingQuote(null, request, NOW)).toEqual({
      status: 'NOT_FOUND',
    });
    expect(
      verifyShippingQuote(stored, { ...request, tenantId: 't-2' }, NOW),
    ).toEqual({ status: 'NOT_FOUND' });
  });

  it('is EXPIRED at expiresAt exactly and after, before any mismatch check', () => {
    expect(verifyShippingQuote(stored, request, stored.expiresAt)).toEqual({
      status: 'EXPIRED',
    });
    expect(
      verifyShippingQuote(
        stored,
        { ...request, lines: [] },
        new Date('2026-11-05T13:00:00.000Z'),
      ),
    ).toEqual({ status: 'EXPIRED' });
    expect(
      verifyShippingQuote(
        stored,
        request,
        new Date(stored.expiresAt.getTime() - 1),
      ).status,
    ).toBe('OK');
  });

  it('is MISMATCH for another customer', () => {
    expect(
      verifyShippingQuote(
        stored,
        {
          ...request,
          customer: { phoneCountryCode: '52', phone: '5500000000' },
        },
        NOW,
      ),
    ).toEqual({ status: 'MISMATCH', mismatches: ['CUSTOMER'] });
  });

  it('is MISMATCH when a quantity, variant or line changes', () => {
    for (const lines of [
      [
        { productId: 'p-1', variantId: 'v-1', quantity: 3 },
        { productId: 'p-2', quantity: 1 },
      ],
      [
        { productId: 'p-1', variantId: 'v-2', quantity: 2 },
        { productId: 'p-2', quantity: 1 },
      ],
      [{ productId: 'p-1', variantId: 'v-1', quantity: 2 }],
    ]) {
      expect(verifyShippingQuote(stored, { ...request, lines }, NOW)).toEqual({
        status: 'MISMATCH',
        mismatches: ['LINES'],
      });
    }
  });

  it('is MISMATCH when the destination changes', () => {
    expect(
      verifyShippingQuote(
        stored,
        {
          ...request,
          destination: { ...request.destination, zipCode: '06600' },
        },
        NOW,
      ),
    ).toEqual({ status: 'MISMATCH', mismatches: ['DESTINATION'] });
  });

  it('ignores case, accents and whitespace in the place labels', () => {
    expect(
      verifyShippingQuote(
        stored,
        {
          ...request,
          customer: { phoneCountryCode: '+52', phone: '55 1234 5678' },
          destination: {
            zipCode: '06700',
            state: '  ciudad  de mexico ',
            municipality: 'CUAUHTEMOC',
            neighborhood: 'roma norte',
          },
        },
        NOW,
      ).status,
    ).toBe('OK');
  });

  it('lists every mismatch', () => {
    expect(
      verifyShippingQuote(
        stored,
        {
          ...request,
          customer: { phoneCountryCode: '1', phone: '5512345678' },
          lines: [],
          destination: { ...request.destination, neighborhood: 'Condesa' },
        },
        NOW,
      ),
    ).toEqual({
      status: 'MISMATCH',
      mismatches: ['CUSTOMER', 'LINES', 'DESTINATION'],
    });
  });
});

describe('computeQuoteExpiry (S8: 30 min, never beyond the carrier validity)', () => {
  it('defaults to now + TTL', () => {
    expect(computeQuoteExpiry(NOW, 30, null)).toEqual(
      new Date('2026-11-05T12:30:00.000Z'),
    );
  });

  it('stops at an earlier carrier validity', () => {
    const validUntil = new Date('2026-11-05T12:10:00.000Z');
    expect(computeQuoteExpiry(NOW, 30, validUntil)).toEqual(validUntil);
  });

  it('keeps the TTL when the carrier rate lives longer (Skydropx 24 h)', () => {
    expect(
      computeQuoteExpiry(NOW, 30, new Date('2026-11-06T12:00:00.000Z')),
    ).toEqual(new Date('2026-11-05T12:30:00.000Z'));
  });
});

describe('quote tokens', () => {
  it('are opaque, unguessable and stored only as a hash', () => {
    const a = generateQuoteToken();
    const b = generateQuoteToken();
    expect(a).toMatch(/^shq_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashQuoteToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashQuoteToken(a)).toBe(hashQuoteToken(a));
    expect(hashQuoteToken(a)).not.toBe(hashQuoteToken(b));
  });
});
