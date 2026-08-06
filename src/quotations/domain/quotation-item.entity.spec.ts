/**
 * QuotationItem Entity — Unit Tests (RED phase)
 *
 * Covers T003: QuotationItem.create() + fromPersistence() + toResponse().
 */
import { QuotationItem } from './quotation-item.entity';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import type { QuotationItemProps } from './quotation-item.entity';

describe('QuotationItem Entity', () => {
  const validItemProps = {
    id: '550e8400-e29b-41d4-a716-446655440010',
    quotationId: '550e8400-e29b-41d4-a716-446655440000',
    productId: 'prod-001',
    variantId: null as string | null,
    productName: 'Test Product',
    variantName: null as string | null,
    quantity: 2,
    unitPriceCents: 5000,
    unitPriceCurrency: 'MXN',
  };

  describe('create', () => {
    it('should create a quotation item without variant', () => {
      const item = QuotationItem.create(validItemProps);

      expect(item.id).toBe(validItemProps.id);
      expect(item.quotationId).toBe(validItemProps.quotationId);
      expect(item.productId).toBe('prod-001');
      expect(item.variantId).toBeNull();
      expect(item.productName).toBe('Test Product');
      expect(item.variantName).toBeNull();
      expect(item.quantity).toBe(2);
      expect(item.unitPriceCents).toBe(5000);
      expect(item.unitPriceCurrency).toBe('MXN');
      expect(item.priceSource).toBe('PRICE_LIST');
    });

    it('should create a quotation item with variant', () => {
      const item = QuotationItem.create({
        ...validItemProps,
        variantId: 'var-red',
        variantName: 'Red',
      });

      expect(item.variantId).toBe('var-red');
      expect(item.variantName).toBe('Red');
    });

    it('should default priceSource to PRICE_LIST', () => {
      const item = QuotationItem.create(validItemProps);
      expect(item.priceSource).toBe('PRICE_LIST');
    });

    it('should accept CUSTOM priceSource on creation (manual override at add-time)', () => {
      const item = QuotationItem.create({
        ...validItemProps,
        priceSource: 'CUSTOM',
      });
      expect(item.priceSource).toBe('CUSTOM');
    });

    it('should default discount fields to zero / null', () => {
      const item = QuotationItem.create(validItemProps);
      expect(item.discountType).toBeNull();
      expect(item.discountValue).toBeNull();
      expect(item.discountAmountCents).toBe(0);
      expect(item.promotionId).toBeNull();
    });

    it('should throw InvalidArgumentError when quantity < 1', () => {
      expect(() =>
        QuotationItem.create({ ...validItemProps, quantity: 0 }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError when quantity is negative', () => {
      expect(() =>
        QuotationItem.create({ ...validItemProps, quantity: -1 }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError when unitPriceCents is negative', () => {
      expect(() =>
        QuotationItem.create({ ...validItemProps, unitPriceCents: -100 }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError when productId is empty', () => {
      expect(() =>
        QuotationItem.create({ ...validItemProps, productId: '' }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError when productName is empty', () => {
      expect(() =>
        QuotationItem.create({ ...validItemProps, productName: '' }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError when id is empty', () => {
      expect(() =>
        QuotationItem.create({ ...validItemProps, id: '' }),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe('fromPersistence', () => {
    it('should reconstitute item from database data', () => {
      const item = QuotationItem.fromPersistence({
        id: '550e8400-e29b-41d4-a716-446655440010',
        quotationId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: 'var-blue',
        productName: 'Persisted Product',
        variantName: 'Blue',
        quantity: 3,
        unitPriceCents: 7500,
        unitPriceCurrency: 'MXN',
        priceSource: 'CUSTOM',
        appliedPriceListId: null,
        customPriceCents: 7500,
        discountType: 'percentage',
        discountValue: 10,
        discountAmountCents: 750,
        promotionId: 'promo-001',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: new Date('2026-07-02T00:00:00Z'),
      });

      expect(item.id).toBe('550e8400-e29b-41d4-a716-446655440010');
      expect(item.variantId).toBe('var-blue');
      expect(item.variantName).toBe('Blue');
      expect(item.quantity).toBe(3);
      expect(item.priceSource).toBe('CUSTOM');
      expect(item.discountType).toBe('percentage');
      expect(item.discountValue).toBe(10);
      expect(item.discountAmountCents).toBe(750);
      expect(item.promotionId).toBe('promo-001');
      expect(item.subtotalCents).toBe(3 * 7500); // 22500 (pre-discount subtotal)
    });

    it('should default discount fields to zero / null when omitted', () => {
      const item = QuotationItem.fromPersistence({
        id: '550e8400-e29b-41d4-a716-446655440010',
        quotationId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      expect(item.priceSource).toBe('PRICE_LIST');
      expect(item.discountType).toBeNull();
      expect(item.discountValue).toBeNull();
      expect(item.discountAmountCents).toBe(0);
      expect(item.promotionId).toBeNull();
    });
  });

  describe('toResponse', () => {
    it('should return the wire shape with all persisted fields', () => {
      const item = QuotationItem.fromPersistence({
        id: 'item-1',
        quotationId: 'q-1',
        productId: 'prod-001',
        variantId: 'var-1',
        productName: 'Product 1',
        variantName: 'Variant 1',
        quantity: 4,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
        priceSource: 'PRICE_LIST',
        appliedPriceListId: 'pl-1',
        customPriceCents: null,
        discountType: 'amount',
        discountValue: 200,
        discountAmountCents: 200,
        promotionId: 'promo-1',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: new Date('2026-07-02T00:00:00Z'),
      });

      const response = item.toResponse();

      expect(response).toMatchObject({
        id: 'item-1',
        productId: 'prod-001',
        variantId: 'var-1',
        productName: 'Product 1',
        variantName: 'Variant 1',
        quantity: 4,
        unitPriceCents: 1000,
        priceSource: 'PRICE_LIST',
        appliedPriceListId: 'pl-1',
        discountType: 'amount',
        discountValue: 200,
        discountAmountCents: 200,
        promotionId: 'promo-1',
      });
      expect(response.subtotalCents).toBe(4 * 1000);
    });
  });

  describe('changeQuantity', () => {
    it('should update quantity when >= 1', () => {
      const item = QuotationItem.create(validItemProps);
      item.changeQuantity(5);
      expect(item.quantity).toBe(5);
    });

    it('should throw when new quantity is zero', () => {
      const item = QuotationItem.create(validItemProps);
      expect(() => item.changeQuantity(0)).toThrow(InvalidArgumentError);
    });
  });

  describe('matches', () => {
    it('should match same product and variant', () => {
      const item = QuotationItem.create({
        ...validItemProps,
        variantId: 'var-x',
      });
      expect(item.matches('prod-001', 'var-x')).toBe(true);
    });

    it('should not match different product', () => {
      const item = QuotationItem.create(validItemProps);
      expect(item.matches('prod-other', null)).toBe(false);
    });

    it('should not match different variant', () => {
      const item = QuotationItem.create({
        ...validItemProps,
        variantId: 'var-x',
      });
      expect(item.matches('prod-001', 'var-y')).toBe(false);
    });
  });

  describe('WU3 — reprice (engine-driven tier re-resolution)', () => {
    it('updates unitPriceCents + priceSource + appliedPriceListId', () => {
      const item = QuotationItem.create(validItemProps);
      item.reprice({
        priceCents: 800,
        priceSource: 'PRICE_LIST',
        appliedPriceListId: 'pl-1',
      });
      expect(item.unitPriceCents).toBe(800);
      expect(item.priceSource).toBe('PRICE_LIST');
      expect(item.appliedPriceListId).toBe('pl-1');
    });

    it('rejects priceSource=CUSTOM (sticky is owned by overridePrice)', () => {
      const item = QuotationItem.create(validItemProps);
      expect(() =>
        item.reprice({
          priceCents: 800,
          priceSource: 'CUSTOM',
          appliedPriceListId: null,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('rejects negative priceCents', () => {
      const item = QuotationItem.create(validItemProps);
      expect(() =>
        item.reprice({
          priceCents: -1,
          priceSource: 'PRICE_LIST',
          appliedPriceListId: null,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('does NOT clear discount fields (promo state preserved across reprice)', () => {
      const item = QuotationItem.create({
        ...validItemProps,
        discountType: 'percentage',
        discountValue: 10,
        discountAmountCents: 500,
        promotionId: 'promo-1',
      });
      item.reprice({
        priceCents: 800,
        priceSource: 'PRICE_LIST',
        appliedPriceListId: 'pl-1',
      });
      // Discount fields untouched — only overridePrice clears them.
      expect(item.discountType).toBe('percentage');
      expect(item.discountValue).toBe(10);
      expect(item.discountAmountCents).toBe(500);
      expect(item.promotionId).toBe('promo-1');
    });
  });

  describe('WU3 — overridePrice (cashier-explicit sticky override)', () => {
    it('mutates priceSource to CUSTOM and clears discount fields', () => {
      const item = QuotationItem.create({
        ...validItemProps,
        discountType: 'percentage',
        discountValue: 10,
        discountAmountCents: 500,
        promotionId: 'promo-1',
      });
      item.overridePrice({
        priceCents: 2500,
        priceSource: 'CUSTOM',
        appliedPriceListId: null,
        customPriceCents: 2500,
      });
      expect(item.unitPriceCents).toBe(2500);
      expect(item.priceSource).toBe('CUSTOM');
      expect(item.customPriceCents).toBe(2500);
      expect(item.appliedPriceListId).toBeNull();
      // Discount fields cleared so the recompute re-applies eligible AUTO promos.
      expect(item.discountType).toBeNull();
      expect(item.discountValue).toBeNull();
      expect(item.discountAmountCents).toBe(0);
      expect(item.promotionId).toBeNull();
    });

    it('rejects a CUSTOM override with a non-null appliedPriceListId', () => {
      const item = QuotationItem.create(validItemProps);
      expect(() =>
        item.overridePrice({
          priceCents: 100,
          priceSource: 'CUSTOM',
          appliedPriceListId: 'pl-1',
          customPriceCents: 100,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('rejects a PRICE_LIST override with a null customPriceCents', () => {
      const item = QuotationItem.create(validItemProps);
      // PRICE_LIST requires a priceListId AND customPriceCents === null.
      expect(() =>
        item.overridePrice({
          priceCents: 100,
          priceSource: 'PRICE_LIST',
          appliedPriceListId: null,
          customPriceCents: null,
        }),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe('WU3 — applyDiscount (per-line discount applier)', () => {
    it('applies a percentage discount and rewrites unitPriceCents to the NET', () => {
      const item = QuotationItem.create(validItemProps);
      item.applyDiscount({
        type: 'percentage',
        percent: 10,
        discountTitle: '10% off',
        promotionId: 'promo-1',
      });
      expect(item.discountType).toBe('percentage');
      expect(item.discountValue).toBe(10);
      expect(item.discountAmountCents).toBe(500); // 10% of 5000
      expect(item.unitPriceCents).toBe(4500); // 5000 - 500
      expect(item.promotionId).toBe('promo-1');
    });

    it('applies an amount discount', () => {
      const item = QuotationItem.create(validItemProps);
      item.applyDiscount({
        type: 'amount',
        amountCents: 200,
        discountTitle: '$2 off',
        promotionId: 'promo-1',
      });
      expect(item.discountType).toBe('amount');
      expect(item.discountValue).toBe(200);
      expect(item.discountAmountCents).toBe(200);
      expect(item.unitPriceCents).toBe(4800);
    });

    it('clamps percentage to 1..99 in the applied amount', () => {
      const item = QuotationItem.create(validItemProps);
      item.applyDiscount({ type: 'percentage', percent: 100 });
      // The raw value is stored verbatim (matches SaleItem behavior);
      // the clamp is applied to the math on `discountAmountCents` to
      // prevent 100% from wiping the line.
      expect(item.discountAmountCents).toBe(4950); // 99% of 5000
      expect(item.unitPriceCents).toBe(50); // 5000 - 4950
    });

    it('rejects a discount that would push unitPriceCents < 1', () => {
      const item = QuotationItem.create(validItemProps);
      expect(() =>
        item.applyDiscount({ type: 'amount', amountCents: 10000 }),
      ).toThrow(InvalidArgumentError);
    });

    it('rejects an input with both amountCents and percent set', () => {
      const item = QuotationItem.create(validItemProps);
      expect(() =>
        item.applyDiscount({
          type: 'amount',
          amountCents: 100,
          percent: 10,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('stores promotionId when present (promo-sourced discount)', () => {
      const item = QuotationItem.create(validItemProps);
      item.applyDiscount({
        type: 'percentage',
        percent: 5,
        promotionId: 'promo-x',
      });
      expect(item.promotionId).toBe('promo-x');
    });

    it('leaves promotionId null when omitted (manual free-form discount)', () => {
      const item = QuotationItem.create(validItemProps);
      item.applyDiscount({
        type: 'percentage',
        percent: 5,
      });
      expect(item.promotionId).toBeNull();
    });
  });

  describe('WU3 — removeDiscount', () => {
    it('restores unitPriceCents to the pre-discount baseline', () => {
      const item = QuotationItem.create(validItemProps);
      item.applyDiscount({
        type: 'percentage',
        percent: 10,
        promotionId: 'promo-1',
      });
      expect(item.unitPriceCents).toBe(4500);
      item.removeDiscount();
      expect(item.unitPriceCents).toBe(5000);
      expect(item.discountType).toBeNull();
      expect(item.discountValue).toBeNull();
      expect(item.discountAmountCents).toBe(0);
      expect(item.promotionId).toBeNull();
    });

    it('is idempotent', () => {
      const item = QuotationItem.create(validItemProps);
      item.removeDiscount();
      item.removeDiscount();
      expect(item.unitPriceCents).toBe(5000);
    });
  });
});
