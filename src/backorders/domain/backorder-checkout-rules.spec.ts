/**
 * restock-backorder / T3 — the rules a checkout line with `backorderId` must
 * satisfy (contract v1 §7). Pure: the state comes from the locked backorder row.
 */
import { BackorderCheckoutError } from '../../sales/domain/backorder-checkout.port';
import {
  assertBackorderCheckoutable,
  type CheckoutBackorderRow,
  type CheckoutBackorderLine,
} from './backorder-checkout-rules';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const CUSTOMER = 'customer-1';

const row = (
  overrides: Partial<CheckoutBackorderRow> = {},
): CheckoutBackorderRow => ({
  id: 'bo-1',
  status: 'RESERVED',
  customerId: CUSTOMER,
  productId: 'product-1',
  variantId: null,
  quantity: 2,
  finalPriceCents: 900,
  reservedUntil: new Date(NOW.getTime() + 3_600_000),
  ...overrides,
});

const line = (
  overrides: Partial<CheckoutBackorderLine> = {},
): CheckoutBackorderLine => ({
  backorderId: 'bo-1',
  productId: 'product-1',
  variantId: null,
  quantity: 2,
  unitPriceCents: 900,
  ...overrides,
});

const failure = (work: () => unknown): BackorderCheckoutError => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(BackorderCheckoutError);
    return error as BackorderCheckoutError;
  }
  throw new Error('expected a BackorderCheckoutError');
};

describe('assertBackorderCheckoutable (§7)', () => {
  it('accepts a RESERVED, unexpired backorder that matches the line and returns the frozen unit price', () => {
    expect(assertBackorderCheckoutable(row(), line(), CUSTOMER, NOW)).toBe(900);
  });

  it('answers 404 BACKORDER_NOT_FOUND for a missing row', () => {
    const error = failure(() =>
      assertBackorderCheckoutable(null, line(), CUSTOMER, NOW),
    );
    expect([error.status, error.code, error.details]).toEqual([
      404,
      'BACKORDER_NOT_FOUND',
      {},
    ]);
  });

  it.each(['WAITING', 'CONFIRMED', 'EXPIRED', 'CANCELLED'] as const)(
    'answers 409 BACKORDER_NOT_RESERVED {status} for %s',
    (status) => {
      const error = failure(() =>
        assertBackorderCheckoutable(
          row({ status, reservedUntil: null }),
          line(),
          CUSTOMER,
          NOW,
        ),
      );
      expect([error.status, error.code, error.details]).toEqual([
        409,
        'BACKORDER_NOT_RESERVED',
        { status },
      ]);
    },
  );

  it('answers 409 BACKORDER_RESERVATION_EXPIRED once reservedUntil is not after now (boundary included)', () => {
    for (const offset of [0, -1, -86_400_000]) {
      const error = failure(() =>
        assertBackorderCheckoutable(
          row({ reservedUntil: new Date(NOW.getTime() + offset) }),
          line(),
          CUSTOMER,
          NOW,
        ),
      );
      expect([error.status, error.code]).toEqual([
        409,
        'BACKORDER_RESERVATION_EXPIRED',
      ]);
    }
    // One millisecond before the deadline still passes.
    expect(
      assertBackorderCheckoutable(
        row({ reservedUntil: new Date(NOW.getTime() + 1) }),
        line(),
        CUSTOMER,
        NOW,
      ),
    ).toBe(900);
  });

  it.each([
    ['customerId', { customerId: 'someone-else' }, {}],
    ['productId', {}, { productId: 'product-2' }],
    ['variantId', { variantId: 'variant-1' }, { variantId: null }],
    ['variantId', {}, { variantId: 'variant-9' }],
    ['quantity', {}, { quantity: 1 }],
    ['quantity', {}, { quantity: 3 }],
  ] as const)(
    'answers 409 BACKORDER_MISMATCH {field: %s}',
    (field, rowChange, lineChange) => {
      const error = failure(() =>
        assertBackorderCheckoutable(
          row(rowChange),
          line(lineChange),
          CUSTOMER,
          NOW,
        ),
      );
      expect([error.status, error.code, error.details]).toEqual([
        409,
        'BACKORDER_MISMATCH',
        { field },
      ]);
    },
  );

  it('treats an omitted variantId like null', () => {
    expect(
      assertBackorderCheckoutable(
        row({ variantId: null }),
        line({ variantId: undefined }),
        CUSTOMER,
        NOW,
      ),
    ).toBe(900);
  });

  it.each([899, 901, 0])(
    'answers 409 PRICE_OUT_OF_DATE {currentPriceCents} when unitPriceCents is %i, not finalPriceCents',
    (unitPriceCents) => {
      const error = failure(() =>
        assertBackorderCheckoutable(
          row(),
          line({ unitPriceCents }),
          CUSTOMER,
          NOW,
        ),
      );
      expect([error.status, error.code, error.details]).toEqual([
        409,
        'PRICE_OUT_OF_DATE',
        { currentPriceCents: 900 },
      ]);
    },
  );

  it('a zero final price is a valid frozen price', () => {
    expect(
      assertBackorderCheckoutable(
        row({ finalPriceCents: 0 }),
        line({ unitPriceCents: 0 }),
        CUSTOMER,
        NOW,
      ),
    ).toBe(0);
  });

  it('checks in order: state, expiry, customer/product/variant/quantity, then price', () => {
    const expired = row({ reservedUntil: new Date(NOW.getTime() - 1) });
    expect(
      failure(() =>
        assertBackorderCheckoutable(
          row({ status: 'EXPIRED' }),
          line({ quantity: 9, unitPriceCents: 1 }),
          CUSTOMER,
          NOW,
        ),
      ).code,
    ).toBe('BACKORDER_NOT_RESERVED');
    expect(
      failure(() =>
        assertBackorderCheckoutable(
          expired,
          line({ quantity: 9, unitPriceCents: 1 }),
          CUSTOMER,
          NOW,
        ),
      ).code,
    ).toBe('BACKORDER_RESERVATION_EXPIRED');
    expect(
      failure(() =>
        assertBackorderCheckoutable(
          row(),
          line({ quantity: 9, unitPriceCents: 1 }),
          CUSTOMER,
          NOW,
        ),
      ).code,
    ).toBe('BACKORDER_MISMATCH');
  });

  it('a RESERVED row without a deadline is a data fault: expired, never sellable', () => {
    expect(
      failure(() =>
        assertBackorderCheckoutable(
          row({ reservedUntil: null }),
          line(),
          CUSTOMER,
          NOW,
        ),
      ).code,
    ).toBe('BACKORDER_RESERVATION_EXPIRED');
  });
});
