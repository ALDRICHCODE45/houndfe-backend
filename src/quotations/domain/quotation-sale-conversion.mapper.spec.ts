/**
 * Quotation ↔ sale conversion mapping — unit tests (T1 / S2, S5).
 *
 * Pure mapping rules, no I/O:
 *   - sale DRAFT line  → quotation line (S2: "precio vigente")
 *   - quotation line   → sale DRAFT line (S5: quoted price + discount kept)
 *   - dropped adjustments the quotation model cannot represent
 */
import {
  computeDroppedSaleAdjustments,
  mapQuotationLineToSaleLine,
  mapSaleLineToQuotationLine,
  type SaleLineSnapshot,
} from './quotation-sale-conversion.mapper';

const saleLine = (
  overrides: Partial<SaleLineSnapshot> = {},
): SaleLineSnapshot => ({
  id: 'sale-item-1',
  productId: 'prod-1',
  variantId: null,
  quantity: 2,
  unitPriceCents: 10_000,
  prePriceCentsBeforeDiscount: null,
  priceSource: 'price_list',
  appliedPriceListId: null,
  discountType: null,
  discountValue: null,
  discountAmountCents: null,
  discountTitle: null,
  promotionId: null,
  rewardKind: null,
  ...overrides,
});

describe('mapSaleLineToQuotationLine (sale DRAFT → quotation)', () => {
  it('maps a plain price-list line to a PRICE_LIST quotation line keeping the per-item list override', () => {
    const line = mapSaleLineToQuotationLine(
      saleLine({ appliedPriceListId: 'pl-row-1', priceSource: 'price_list' }),
    );
    expect(line).toEqual({
      productId: 'prod-1',
      variantId: null,
      quantity: 2,
      unitPriceCents: 10_000,
      priceSource: 'PRICE_LIST',
      appliedPriceListId: 'pl-row-1',
      customPriceCents: null,
    });
  });

  it("maps a 'default' (PUBLICO) line to PRICE_LIST without a per-item list", () => {
    const line = mapSaleLineToQuotationLine(
      saleLine({ priceSource: 'default' }),
    );
    expect(line.priceSource).toBe('PRICE_LIST');
    expect(line.appliedPriceListId).toBeNull();
  });

  it('maps a cashier custom price to a sticky CUSTOM quotation line', () => {
    const line = mapSaleLineToQuotationLine(
      saleLine({ priceSource: 'custom', unitPriceCents: 7_500 }),
    );
    expect(line).toMatchObject({
      priceSource: 'CUSTOM',
      unitPriceCents: 7_500,
      customPriceCents: 7_500,
      appliedPriceListId: null,
    });
  });

  it('collapses a manual free-form discount into a CUSTOM price equal to the discounted unit price', () => {
    const line = mapSaleLineToQuotationLine(
      saleLine({
        unitPriceCents: 9_000,
        prePriceCentsBeforeDiscount: 10_000,
        discountType: 'percentage',
        discountValue: 10,
        discountAmountCents: 1_000,
        promotionId: null,
      }),
    );
    expect(line).toMatchObject({
      priceSource: 'CUSTOM',
      unitPriceCents: 9_000,
      customPriceCents: 9_000,
      appliedPriceListId: null,
    });
  });

  it('maps a promotion-discounted line at its pre-discount base so the quotation engine re-applies the promotion', () => {
    const line = mapSaleLineToQuotationLine(
      saleLine({
        unitPriceCents: 8_000,
        prePriceCentsBeforeDiscount: 10_000,
        discountType: 'amount',
        discountValue: 2_000,
        discountAmountCents: 2_000,
        promotionId: 'promo-1',
      }),
    );
    expect(line).toMatchObject({
      priceSource: 'PRICE_LIST',
      unitPriceCents: 10_000,
      customPriceCents: null,
    });
  });

  it('keeps a BUY_X_GET_Y reward line at its full unit price (the whole-line reward is not representable)', () => {
    const line = mapSaleLineToQuotationLine(
      saleLine({
        quantity: 3,
        unitPriceCents: 10_000,
        prePriceCentsBeforeDiscount: 10_000,
        discountType: 'amount',
        discountValue: 10_000,
        discountAmountCents: 10_000,
        promotionId: 'bxgy-1',
        rewardKind: 'buy_x_get_y',
      }),
    );
    expect(line).toMatchObject({ unitPriceCents: 10_000, quantity: 3 });
  });
});

describe('computeDroppedSaleAdjustments', () => {
  it('reports the sale-level ORDER promotion, reward lines and line promotions the quotation did not reproduce', () => {
    const dropped = computeDroppedSaleAdjustments({
      saleLines: [
        saleLine({
          id: 'bxgy-line',
          productId: 'prod-bxgy',
          quantity: 3,
          prePriceCentsBeforeDiscount: 10_000,
          discountType: 'amount',
          discountValue: 10_000,
          discountAmountCents: 10_000,
          discountTitle: '2x1',
          promotionId: 'bxgy-1',
          rewardKind: 'buy_x_get_y',
        }),
        saleLine({
          id: 'promo-kept',
          productId: 'prod-kept',
          unitPriceCents: 9_000,
          prePriceCentsBeforeDiscount: 10_000,
          discountType: 'amount',
          discountValue: 1_000,
          discountAmountCents: 1_000,
          promotionId: 'promo-kept',
        }),
        saleLine({
          id: 'promo-lost',
          productId: 'prod-lost',
          quantity: 2,
          unitPriceCents: 9_500,
          prePriceCentsBeforeDiscount: 10_000,
          discountType: 'amount',
          discountValue: 500,
          discountAmountCents: 500,
          discountTitle: 'Promo perdida',
          promotionId: 'promo-lost',
        }),
      ],
      appliedOrderPromotion: {
        promotionId: 'order-1',
        discountAmountCents: 1_500,
        discountTitle: 'Orden 10%',
      },
      quotationLines: [
        { productId: 'prod-bxgy', variantId: null, promotionId: null },
        { productId: 'prod-kept', variantId: null, promotionId: 'promo-kept' },
        { productId: 'prod-lost', variantId: null, promotionId: null },
      ],
    });

    expect(dropped).toEqual([
      {
        kind: 'ORDER_PROMOTION',
        saleItemId: null,
        productId: null,
        variantId: null,
        promotionId: 'order-1',
        title: 'Orden 10%',
        discountCents: 1_500,
      },
      {
        kind: 'REWARD_PROMOTION',
        saleItemId: 'bxgy-line',
        productId: 'prod-bxgy',
        variantId: null,
        promotionId: 'bxgy-1',
        title: '2x1',
        discountCents: 10_000,
      },
      {
        kind: 'LINE_PROMOTION',
        saleItemId: 'promo-lost',
        productId: 'prod-lost',
        variantId: null,
        promotionId: 'promo-lost',
        title: 'Promo perdida',
        discountCents: 1_000,
      },
    ]);
  });

  it('returns [] when nothing was lost', () => {
    expect(
      computeDroppedSaleAdjustments({
        saleLines: [saleLine()],
        appliedOrderPromotion: null,
        quotationLines: [
          { productId: 'prod-1', variantId: null, promotionId: null },
        ],
      }),
    ).toEqual([]);
  });
});

describe('mapQuotationLineToSaleLine (quotation → sale DRAFT, S5)', () => {
  const now = new Date('2026-11-18T12:00:00.000Z');
  const catalog = {
    productName: 'Playera',
    variantName: 'M',
    imageUrl: 'https://img/1.png',
  };

  it('keeps the quoted unit price as a sticky custom price when there is no discount', () => {
    const line = mapQuotationLineToSaleLine(
      {
        productId: 'prod-1',
        variantId: 'var-1',
        quantity: 4,
        unitPriceCents: 12_345,
        discountType: null,
        discountValue: null,
        discountAmountCents: 0,
        promotionId: null,
      },
      { ...catalog, promotionTitle: null, now },
    );
    expect(line).toEqual({
      productId: 'prod-1',
      variantId: 'var-1',
      productName: 'Playera',
      variantName: 'M',
      imageUrl: 'https://img/1.png',
      quantity: 4,
      unitPriceCents: 12_345,
      unitPriceCurrency: 'MXN',
      priceSource: 'custom',
      customPriceCents: 12_345,
      appliedPriceListId: null,
      originalPriceCents: null,
      discountType: null,
      discountValue: null,
      discountAmountCents: null,
      prePriceCentsBeforeDiscount: null,
      discountTitle: null,
      discountedAt: null,
      promotionId: null,
    });
  });

  it('keeps the quoted promotion discount as a sticky manual line discount at the exact quoted cents', () => {
    const line = mapQuotationLineToSaleLine(
      {
        productId: 'prod-1',
        variantId: null,
        quantity: 2,
        unitPriceCents: 8_999,
        discountType: 'percentage',
        discountValue: 10,
        discountAmountCents: 1_000,
        promotionId: 'promo-1',
      },
      { ...catalog, variantName: null, promotionTitle: 'Buen Fin', now },
    );
    expect(line).toMatchObject({
      unitPriceCents: 8_999,
      priceSource: 'custom',
      customPriceCents: 9_999,
      prePriceCentsBeforeDiscount: 9_999,
      discountType: 'percentage',
      discountValue: 10,
      discountAmountCents: 1_000,
      discountTitle: 'Buen Fin',
      discountedAt: now,
      // Manual (promotionId null) so the sale engine never strips it.
      promotionId: null,
    });
  });

  it('S8 — mapped lines reproduce every quoted line total and the quoted order total exactly, all sticky and manual', () => {
    const quoted = [
      {
        productId: 'p-1',
        variantId: null,
        quantity: 3,
        unitPriceCents: 9_999,
        discountType: null,
        discountValue: null,
        discountAmountCents: 0,
        promotionId: null,
      },
      {
        productId: 'p-2',
        variantId: 'v-2',
        quantity: 2,
        unitPriceCents: 4_501,
        discountType: 'percentage' as const,
        discountValue: 10,
        discountAmountCents: 500,
        promotionId: 'promo-q',
      },
    ];
    const quotedTotal = quoted.reduce(
      (sum, l) => sum + l.unitPriceCents * l.quantity,
      0,
    );

    const mapped = quoted.map((l) =>
      mapQuotationLineToSaleLine(l, { ...catalog, promotionTitle: null, now }),
    );

    mapped.forEach((line, i) => {
      const q = quoted[i]!;
      expect(line.unitPriceCents * line.quantity).toBe(
        q.unitPriceCents * q.quantity,
      );
      // Sticky (never repriced) and never tied to a promotion the sale
      // recompute could strip or replace.
      expect(line.priceSource).toBe('custom');
      expect(line.promotionId).toBeNull();
    });
    expect(
      mapped.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0),
    ).toBe(quotedTotal);
  });

  it('falls back to a generic title when the promotion no longer exists', () => {
    const line = mapQuotationLineToSaleLine(
      {
        productId: 'prod-1',
        variantId: null,
        quantity: 1,
        unitPriceCents: 900,
        discountType: 'amount',
        discountValue: 100,
        discountAmountCents: 100,
        promotionId: 'gone',
      },
      { ...catalog, promotionTitle: null, now },
    );
    expect(line.discountTitle).toBe('Descuento cotizado');
  });
});
