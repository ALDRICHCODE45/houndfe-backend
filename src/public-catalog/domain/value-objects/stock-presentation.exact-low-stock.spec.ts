/**
 * Public catalog v0 (S3) — SYSTEM_STATUS_EXACT_LOW_STOCK: the system status
 * plus the real quantity, only while the row is low_stock. Every other mode
 * keeps its rendered shape (no `exactQuantity` key at all).
 */
import {
  renderAggregateVariantStockPresentation,
  renderStockPresentation,
  resolveProductStockPresentation,
  type EffectiveStockPresentationConfig,
} from './stock-presentation.vo';

const EXACT: EffectiveStockPresentationConfig = {
  mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
  customQuantity: null,
};

describe('renderStockPresentation — SYSTEM_STATUS_EXACT_LOW_STOCK', () => {
  it('carries the real quantity when the row is low_stock', () => {
    expect(
      renderStockPresentation(EXACT, {
        useStock: true,
        quantity: 2,
        minQuantity: 3,
      }),
    ).toEqual({
      mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
      status: 'low_stock',
      customQuantity: null,
      exactQuantity: 2,
    });
  });

  it('treats quantity equal to the threshold as low_stock, like SYSTEM_STATUS', () => {
    expect(
      renderStockPresentation(EXACT, {
        useStock: true,
        quantity: 3,
        minQuantity: 3,
      }).exactQuantity,
    ).toBe(3);
  });

  it.each([
    ['available', 10, 'available'],
    ['out of stock', 0, 'out_of_stock'],
  ])(
    'has a null exactQuantity when the row is %s',
    (_label, quantity, status) => {
      expect(
        renderStockPresentation(EXACT, {
          useStock: true,
          quantity,
          minQuantity: 3,
        }),
      ).toEqual({
        mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
        status,
        customQuantity: null,
        exactQuantity: null,
      });
    },
  );

  it('has a null exactQuantity when stock is not tracked', () => {
    expect(
      renderStockPresentation(EXACT, {
        useStock: false,
        quantity: 1,
        minQuantity: 3,
      }),
    ).toEqual({
      mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
      status: 'available',
      customQuantity: null,
      exactQuantity: null,
    });
  });

  it.each([
    'SYSTEM_STATUS',
    'ABSTRACT_STATUS',
    'CUSTOM_QUANTITY',
    'HIDDEN',
  ] as const)(
    'previous behavior holds: %s renders without an exactQuantity key',
    (mode) => {
      const rendered = renderStockPresentation(
        { mode, customQuantity: mode === 'CUSTOM_QUANTITY' ? 4 : null },
        { useStock: true, quantity: 2, minQuantity: 3 },
      );
      expect(rendered).not.toHaveProperty('exactQuantity');
    },
  );
});

describe('renderAggregateVariantStockPresentation — SYSTEM_STATUS_EXACT_LOW_STOCK', () => {
  it('aggregates like SYSTEM_STATUS and never sums variants into an exactQuantity', () => {
    expect(
      renderAggregateVariantStockPresentation(EXACT, true, [
        { quantity: 1, minQuantity: 3 },
        { quantity: 2, minQuantity: 3 },
      ]),
    ).toEqual({
      mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
      status: 'low_stock',
      customQuantity: null,
      exactQuantity: null,
    });
  });

  it('aggregates available-first, exactly as SYSTEM_STATUS', () => {
    expect(
      renderAggregateVariantStockPresentation(EXACT, true, [
        { quantity: 1, minQuantity: 3 },
        { quantity: 9, minQuantity: 3 },
      ]).status,
    ).toBe('available');
  });

  it('previous behavior holds: SYSTEM_STATUS aggregate has no exactQuantity key', () => {
    expect(
      renderAggregateVariantStockPresentation(
        { mode: 'SYSTEM_STATUS', customQuantity: null },
        true,
        [{ quantity: 1, minQuantity: 3 }],
      ),
    ).not.toHaveProperty('exactQuantity');
  });
});

describe('resolveProductStockPresentation — SYSTEM_STATUS_EXACT_LOW_STOCK', () => {
  it('is inherited from the tenant default like any other mode', () => {
    expect(
      resolveProductStockPresentation(
        {
          onlineStockPresentation: null,
          onlineStockPresentationCustomQty: null,
        },
        {
          catalogStockPresentationDefault: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
          catalogStockPresentationDefaultCustomQty: null,
        },
      ),
    ).toEqual({ mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK', customQuantity: null });
  });
});
