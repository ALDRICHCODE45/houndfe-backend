import { SaleItem } from './sale-item.entity';
import { InvalidArgumentError } from '../../shared/domain/domain-error';

describe('SaleItem Entity', () => {
  describe('create - create new sale item', () => {
    const validItemData = {
      id: '550e8400-e29b-41d4-a716-446655440010',
      saleId: '550e8400-e29b-41d4-a716-446655440000',
      productId: 'prod-001',
      variantId: null as string | null,
      productName: 'Test Product',
      variantName: null as string | null,
      quantity: 2,
      unitPriceCents: 5000,
      unitPriceCurrency: 'MXN',
    };

    it('should create sale item without variant', () => {
      const item = SaleItem.create(validItemData);

      expect(item.id).toBe(validItemData.id);
      expect(item.saleId).toBe(validItemData.saleId);
      expect(item.productId).toBe('prod-001');
      expect(item.variantId).toBeNull();
      expect(item.productName).toBe('Test Product');
      expect(item.variantName).toBeNull();
      expect(item.quantity).toBe(2);
      expect(item.unitPriceCents).toBe(5000);
      expect(item.unitPriceCurrency).toBe('MXN');
    });

    it('should create sale item with variant', () => {
      const itemWithVariant = {
        ...validItemData,
        variantId: 'var-red',
        variantName: 'Red',
      };

      const item = SaleItem.create(itemWithVariant);

      expect(item.variantId).toBe('var-red');
      expect(item.variantName).toBe('Red');
    });

    it('should throw InvalidArgumentError if quantity is less than 1', () => {
      expect(() =>
        SaleItem.create({
          ...validItemData,
          quantity: 0,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError if quantity is negative', () => {
      expect(() =>
        SaleItem.create({
          ...validItemData,
          quantity: -1,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError if unitPriceCents is negative', () => {
      expect(() =>
        SaleItem.create({
          ...validItemData,
          unitPriceCents: -100,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError if productId is empty', () => {
      expect(() =>
        SaleItem.create({
          ...validItemData,
          productId: '',
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError if productName is empty', () => {
      expect(() =>
        SaleItem.create({
          ...validItemData,
          productName: '',
        }),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe('fromPersistence - reconstitute from database', () => {
    it('should reconstitute sale item from database data', () => {
      const item = SaleItem.fromPersistence({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(item.id).toBe('550e8400-e29b-41d4-a716-446655440010');
      expect(item.quantity).toBe(2);
    });
  });

  describe('changeQuantity - update item quantity', () => {
    it('should update quantity to new value', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      item.changeQuantity(5);

      expect(item.quantity).toBe(5);
    });

    it('should throw InvalidArgumentError if new quantity is less than 1', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(() => item.changeQuantity(0)).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError if new quantity is negative', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(() => item.changeQuantity(-1)).toThrow(InvalidArgumentError);
    });
  });

  describe('matches - check if item matches product+variant combination', () => {
    it('should return true for matching productId when no variant', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(item.matches('prod-001', null)).toBe(true);
    });

    it('should return false for different productId', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(item.matches('prod-002', null)).toBe(false);
    });

    it('should return true for matching productId and variantId', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: 'var-red',
        productName: 'Test Product',
        variantName: 'Red',
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(item.matches('prod-001', 'var-red')).toBe(true);
    });

    it('should return false for same product but different variant', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: 'var-red',
        productName: 'Test Product',
        variantName: 'Red',
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(item.matches('prod-001', 'var-blue')).toBe(false);
    });
  });

  describe('toResponse - convert to API response', () => {
    it('should return response object with all fields', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: 'var-red',
        productName: 'Test Product',
        variantName: 'Red',
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      const response = item.toResponse();

      expect(response.id).toBe('550e8400-e29b-41d4-a716-446655440010');
      expect(response.productId).toBe('prod-001');
      expect(response.variantId).toBe('var-red');
      expect(response.productName).toBe('Test Product');
      expect(response.variantName).toBe('Red');
      expect(response.quantity).toBe(2);
      expect(response.unitPriceCents).toBe(5000);
      expect(response.unitPriceCurrency).toBe('MXN');
    });
  });

  describe('overridePrice - override item unit price', () => {
    it('should override using price list and preserve original price immutability', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      item.overridePrice({
        priceCents: 4500,
        priceSource: 'price_list',
        appliedPriceListId: 'list-1',
        customPriceCents: null,
      });

      expect(item.unitPriceCents).toBe(4500);
      expect(item.originalPriceCents).toBe(5000);
      expect(item.priceSource).toBe('price_list');
      expect(item.appliedPriceListId).toBe('list-1');
      expect(item.customPriceCents).toBeNull();

      item.overridePrice({
        priceCents: 4300,
        priceSource: 'price_list',
        appliedPriceListId: 'list-2',
        customPriceCents: null,
      });

      expect(item.unitPriceCents).toBe(4300);
      expect(item.originalPriceCents).toBe(5000);
      expect(item.appliedPriceListId).toBe('list-2');
    });

    it('should override using custom price and clear applied list', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      item.overridePrice({
        priceCents: 12345,
        priceSource: 'custom',
        appliedPriceListId: null,
        customPriceCents: 12345,
      });

      expect(item.unitPriceCents).toBe(12345);
      expect(item.priceSource).toBe('custom');
      expect(item.customPriceCents).toBe(12345);
      expect(item.appliedPriceListId).toBeNull();
    });

    it('should reject invalid override payload combinations', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(() =>
        item.overridePrice({
          priceCents: 1,
          priceSource: 'custom',
          appliedPriceListId: 'list-1',
          customPriceCents: 1,
        }),
      ).toThrow(InvalidArgumentError);

      expect(() =>
        item.overridePrice({
          priceCents: 1,
          priceSource: 'price_list',
          appliedPriceListId: null,
          customPriceCents: null,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should clear active discount fields when overriding price', () => {
      const item = SaleItem.create({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: '550e8400-e29b-41d4-a716-446655440000',
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      item.applyDiscount({ type: 'percentage', percent: 20, discountTitle: 'Promo' });
      item.overridePrice({
        priceCents: 900,
        priceSource: 'custom',
        appliedPriceListId: null,
        customPriceCents: 900,
      });

      expect(item.discountType).toBeNull();
      expect(item.discountValue).toBeNull();
      expect(item.discountAmountCents).toBeNull();
      expect(item.prePriceCentsBeforeDiscount).toBeNull();
      expect(item.discountTitle).toBeNull();
      expect(item.discountedAt).toBeNull();
    });
  });

  describe('discount behavior', () => {
    it('applies percentage discount and stores metadata', () => {
      const item = SaleItem.create({
        id: 'i1', saleId: 's1', productId: 'p1', variantId: null, productName: 'P', variantName: null,
        quantity: 1, unitPriceCents: 1000, unitPriceCurrency: 'MXN',
      });

      item.applyDiscount({ type: 'percentage', percent: 15, discountTitle: '15 off' });

      expect(item.unitPriceCents).toBe(850);
      expect(item.discountType).toBe('percentage');
      expect(item.discountValue).toBe(15);
      expect(item.discountAmountCents).toBe(150);
      expect(item.prePriceCentsBeforeDiscount).toBe(1000);
      expect(item.discountTitle).toBe('15 off');
      expect(item.discountedAt).toBeInstanceOf(Date);
    });

    it('replaces discount from original baseline (no stacking)', () => {
      const item = SaleItem.create({
        id: 'i2', saleId: 's1', productId: 'p1', variantId: null, productName: 'P', variantName: null,
        quantity: 1, unitPriceCents: 1000, unitPriceCurrency: 'MXN',
      });

      item.applyDiscount({ type: 'percentage', percent: 10 });
      item.applyDiscount({ type: 'amount', amountCents: 200 });

      expect(item.unitPriceCents).toBe(800);
      expect(item.prePriceCentsBeforeDiscount).toBe(1000);
      expect(item.discountAmountCents).toBe(200);
    });

    it('rejects 100% discount', () => {
      const item = SaleItem.create({
        id: 'i3', saleId: 's1', productId: 'p1', variantId: null, productName: 'P', variantName: null,
        quantity: 1, unitPriceCents: 1000, unitPriceCurrency: 'MXN',
      });

      expect(() => item.applyDiscount({ type: 'percentage', percent: 100 })).toThrow(
        /DISCOUNT_PERCENT_INVALID/,
      );
    });

    it('rejects amount that leaves price below 1', () => {
      const item = SaleItem.create({
        id: 'i4', saleId: 's1', productId: 'p1', variantId: null, productName: 'P', variantName: null,
        quantity: 1, unitPriceCents: 1000, unitPriceCurrency: 'MXN',
      });

      expect(() => item.applyDiscount({ type: 'amount', amountCents: 1000 })).toThrow(
        /DISCOUNT_AMOUNT_INVALID/,
      );
    });

    it('removeDiscount restores price and is idempotent', () => {
      const item = SaleItem.create({
        id: 'i5', saleId: 's1', productId: 'p1', variantId: null, productName: 'P', variantName: null,
        quantity: 1, unitPriceCents: 1000, unitPriceCurrency: 'MXN',
      });

      item.applyDiscount({ type: 'amount', amountCents: 200 });
      item.removeDiscount();
      item.removeDiscount();

      expect(item.unitPriceCents).toBe(1000);
      expect(item.discountType).toBeNull();
      expect(item.discountTitle).toBeNull();
    });
  });
});
