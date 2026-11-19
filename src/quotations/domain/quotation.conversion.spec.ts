/**
 * Quotation aggregate — CONVERTED_TO_SALE lifecycle (T1 / S4, S5, S6).
 *
 * Also pins that the existing send / cancel / lazy-expiry flows behave
 * exactly as before for quotations that were never converted.
 */
import { Quotation, type QuotationStatus } from './quotation.entity';
import type { QuotationItemProps } from './quotation-item.entity';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const PAST = new Date('2026-11-01T00:00:00.000Z');
const FUTURE = new Date('2026-12-31T00:00:00.000Z');

const item = (
  overrides: Partial<QuotationItemProps> = {},
): QuotationItemProps => ({
  id: 'item-1',
  quotationId: 'q-1',
  productId: 'prod-1',
  variantId: null,
  productName: 'Producto',
  variantName: null,
  quantity: 1,
  unitPriceCents: 1_000,
  ...overrides,
});

const quotation = (
  status: QuotationStatus,
  overrides: Partial<Parameters<typeof Quotation.fromPersistence>[0]> = {},
) =>
  Quotation.fromPersistence({
    id: 'q-1',
    sellerUserId: 'seller-1',
    customerId: null,
    globalPriceListId: null,
    priceListExplicitlySet: false,
    status,
    expiresAt: null,
    cancelReason: null,
    subtotalCents: 1_000,
    discountCents: 0,
    totalCents: 1_000,
    manuallyEnded: false,
    items: [item()],
    vetoedPromotionIds: [],
    optedInManualPromotionIds: [],
    createdAt: PAST,
    updatedAt: PAST,
    ...overrides,
  });

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as BusinessRuleViolationError).code;
  }
  return undefined;
};

describe('Quotation — CONVERTED_TO_SALE lifecycle', () => {
  it.each(['DRAFT', 'SENT'] as const)(
    'converts a non-expired %s quotation and records the sale link',
    (status) => {
      const converted = quotation(status, {
        expiresAt: FUTURE,
      }).markConvertedToSale('sale-1', NOW);
      expect(converted.status).toBe('CONVERTED_TO_SALE');
      expect(converted.convertedSaleId).toBe('sale-1');
      expect(converted.convertedAt).toEqual(NOW);
      expect(converted.toResponse()).toMatchObject({
        status: 'CONVERTED_TO_SALE',
        saleId: 'sale-1',
        convertedAt: NOW,
      });
    },
  );

  it('rejects an EXPIRED quotation with QUOTATION_EXPIRED', () => {
    expect(
      codeOf(() => quotation('EXPIRED').assertConvertibleToSale(NOW)),
    ).toBe('QUOTATION_EXPIRED');
  });

  it.each(['DRAFT', 'SENT'] as const)(
    'rejects a %s quotation whose expiresAt already passed (lazy expiry) with QUOTATION_EXPIRED',
    (status) => {
      expect(
        codeOf(() =>
          quotation(status, { expiresAt: PAST }).assertConvertibleToSale(NOW),
        ),
      ).toBe('QUOTATION_EXPIRED');
    },
  );

  it('rejects a CANCELLED quotation with QUOTATION_CANCELLED', () => {
    expect(
      codeOf(() => quotation('CANCELLED').assertConvertibleToSale(NOW)),
    ).toBe('QUOTATION_CANCELLED');
  });

  it('rejects an already converted quotation with QUOTATION_ALREADY_CONVERTED carrying the saleId', () => {
    const converted = quotation('CONVERTED_TO_SALE', {
      convertedSaleId: 'sale-9',
    });
    try {
      converted.assertConvertibleToSale(NOW);
      fail('expected rejection');
    } catch (err) {
      expect((err as BusinessRuleViolationError).code).toBe(
        'QUOTATION_ALREADY_CONVERTED',
      );
      expect((err as BusinessRuleViolationError).details).toEqual({
        saleId: 'sale-9',
      });
    }
  });

  it('rejects a quotation without items with QUOTATION_HAS_NO_ITEMS', () => {
    expect(
      codeOf(() =>
        quotation('DRAFT', { items: [] }).assertConvertibleToSale(NOW),
      ),
    ).toBe('QUOTATION_HAS_NO_ITEMS');
  });

  it('allows a re-conversion when the linked draft sale was discarded (link set to null)', () => {
    const orphan = quotation('CONVERTED_TO_SALE', { convertedSaleId: null });
    expect(() => orphan.assertConvertibleToSale(NOW)).not.toThrow();
  });

  it('is terminal for the lazy expiry: a converted quotation past expiresAt stays CONVERTED_TO_SALE', () => {
    const converted = quotation('CONVERTED_TO_SALE', {
      convertedSaleId: 'sale-1',
      expiresAt: PAST,
    });
    expect(converted.getEffectiveStatus(NOW)).toBe('CONVERTED_TO_SALE');
  });

  it('cannot be edited, sent or cancelled once converted', () => {
    const converted = quotation('CONVERTED_TO_SALE', {
      convertedSaleId: 'sale-1',
    });
    expect(codeOf(() => converted.setNotes('x'))).toBe('QUOTATION_NOT_DRAFT');
    expect(codeOf(() => converted.send(NOW))).toBe('QUOTATION_NOT_DRAFT');
    expect(codeOf(() => converted.cancel('OTHER', NOW))).toBe(
      'QUOTATION_ALREADY_CONVERTED',
    );
  });

  it('exposes saleId: null on quotations that were never converted', () => {
    expect(quotation('DRAFT').toResponse()).toMatchObject({
      saleId: null,
      convertedAt: null,
    });
  });
});

describe('Quotation — existing flows unchanged for non-converted quotations', () => {
  it('send still flips DRAFT → SENT and carries a null sale link', () => {
    const sent = quotation('DRAFT').send(NOW);
    expect(sent.status).toBe('SENT');
    expect(sent.convertedSaleId).toBeNull();
  });

  it('cancel still works from DRAFT, SENT and EXPIRED and stays idempotent', () => {
    for (const status of ['DRAFT', 'SENT', 'EXPIRED'] as const) {
      const cancelled = quotation(status).cancel('CUSTOMER_REQUEST', NOW);
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancel('OTHER', NOW)).toBe(cancelled);
    }
  });

  it('lazy expiry still flips SENT past expiresAt to EXPIRED and leaves a future expiry alone', () => {
    expect(quotation('SENT', { expiresAt: PAST }).getEffectiveStatus(NOW)).toBe(
      'EXPIRED',
    );
    expect(
      quotation('SENT', { expiresAt: FUTURE }).getEffectiveStatus(NOW),
    ).toBe('SENT');
    expect(
      quotation('CANCELLED', { expiresAt: PAST }).getEffectiveStatus(NOW),
    ).toBe('CANCELLED');
  });
});
