import {
  applyShippingCredit,
  computeShippingCredit,
  DEFAULT_SHIPPING_CREDIT_RULE,
  type ShippingCreditRule,
} from './shipping-credit';
import { resolveQuoteEta } from './shipping-eta';

const rule = DEFAULT_SHIPPING_CREDIT_RULE;

describe('computeShippingCredit (S7 "$120 MXN por artículo de más de $500", por unidad)', () => {
  it('defaults to 12000 cents per unit above 50000 cents, applying to surcharge', () => {
    expect(rule).toEqual({
      perUnitCreditCents: 12000,
      unitPriceThresholdCents: 50000,
      appliesToSurcharge: true,
    });
  });

  it('counts every unit of a qualifying line and sums across lines', () => {
    expect(
      computeShippingCredit(
        [
          { quantity: 3, finalPriceCents: 3 * 60000 },
          { quantity: 1, finalPriceCents: 50001 },
        ],
        rule,
      ),
    ).toBe(4 * 12000);
  });

  it('requires strictly more than the threshold: exactly $500 earns nothing', () => {
    expect(
      computeShippingCredit([{ quantity: 2, finalPriceCents: 100000 }], rule),
    ).toBe(0);
    expect(
      computeShippingCredit([{ quantity: 2, finalPriceCents: 100002 }], rule),
    ).toBe(24000);
  });

  it('uses the unit price AFTER discounts (line total / quantity)', () => {
    // 2 × $600 with a 2x1 reward → $300 per unit after discounts.
    expect(
      computeShippingCredit([{ quantity: 2, finalPriceCents: 60000 }], rule),
    ).toBe(0);
    // 3 units at a $1500.01 line total: average $500.0033 > $500.
    expect(
      computeShippingCredit([{ quantity: 3, finalPriceCents: 150001 }], rule),
    ).toBe(36000);
  });

  it('follows a configured rule instead of the defaults', () => {
    const custom: ShippingCreditRule = {
      perUnitCreditCents: 5000,
      unitPriceThresholdCents: 10000,
      appliesToSurcharge: false,
    };
    expect(
      computeShippingCredit([{ quantity: 2, finalPriceCents: 30000 }], custom),
    ).toBe(10000);
  });
});

describe('applyShippingCredit (customer pays max(0, cost − credit))', () => {
  it('caps the applied credit at the cost', () => {
    expect(
      applyShippingCredit({ costCents: 9000, creditCents: 24000 }, true),
    ).toEqual({ costCents: 9000, creditCents: 9000, customerChargeCents: 0 });
  });

  it('subtracts a smaller credit', () => {
    expect(
      applyShippingCredit({ costCents: 30000, creditCents: 12000 }, true),
    ).toEqual({
      costCents: 30000,
      creditCents: 12000,
      customerChargeCents: 18000,
    });
  });

  it('applies no credit where the rule does not apply', () => {
    expect(
      applyShippingCredit({ costCents: 4500, creditCents: 12000 }, false),
    ).toEqual({ costCents: 4500, creditCents: 0, customerChargeCents: 4500 });
  });

  it('keeps a free delivery at zero', () => {
    expect(
      applyShippingCredit({ costCents: 0, creditCents: 12000 }, true),
    ).toEqual({ costCents: 0, creditCents: 0, customerChargeCents: 0 });
  });
});

describe('resolveQuoteEta (S9 "Base + ajustes")', () => {
  it('promises the zone/carrier days when every line has sellable stock', () => {
    expect(resolveQuoteEta(3, false)).toEqual({ days: 3, reason: null });
  });

  it('withholds the days when a line lacks sellable stock', () => {
    expect(resolveQuoteEta(3, true)).toEqual({
      days: null,
      reason: 'STOCK_PENDING',
    });
  });

  it('reports no days when the carrier gave none', () => {
    expect(resolveQuoteEta(null, false)).toEqual({ days: null, reason: null });
  });
});
