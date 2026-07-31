/**
 * QuotationItem Entity — Unit Tests (RED phase)
 *
 * Covers T003: QuotationItem.create() + fromPersistence() + toResponse().
 */
import { QuotationItem } from './quotation-item.entity';
import { InvalidArgumentError } from '../../shared/domain/domain-error';

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
});
