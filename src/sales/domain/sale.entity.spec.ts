import { Sale } from './sale.entity';
import { SaleItem } from './sale-item.entity';
import {
  InvalidArgumentError,
  BusinessRuleViolationError,
} from '../../shared/domain/domain-error';

const BASE_SALE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '550e8400-e29b-41d4-a716-446655440001';

describe('Sale Entity', () => {
  describe('create - create new DRAFT sale', () => {
    it('should create a DRAFT sale with required fields', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      expect(sale.id).toBe(BASE_SALE_ID);
      expect(sale.userId).toBe(USER_ID);
      expect(sale.status).toBe('DRAFT');
      expect(sale.items).toEqual([]);
    });

    it('should throw InvalidArgumentError if userId is empty', () => {
      expect(() =>
        Sale.create({
          id: BASE_SALE_ID,
          userId: '',
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError if id is empty', () => {
      expect(() =>
        Sale.create({
          id: '',
          userId: USER_ID,
        }),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe('fromPersistence - reconstitute from database', () => {
    it('should reconstitute sale with empty items', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(sale.id).toBe(BASE_SALE_ID);
      expect(sale.userId).toBe(USER_ID);
      expect(sale.status).toBe('DRAFT');
      expect(sale.items).toEqual([]);
    });

    it('should reconstitute sale with existing items', () => {
      const itemData = {
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      };

      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        items: [itemData],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].productId).toBe('prod-001');
      expect(sale.items[0].quantity).toBe(2);
    });
  });

  describe('addItem - add new item to sale', () => {
    it('should add new item when product not yet in sale', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].productId).toBe('prod-001');
      expect(sale.items[0].quantity).toBe(2);
      expect(sale.items[0].unitPriceCents).toBe(5000);
    });

    it('should stack quantity when adding same product+variant combination', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440011',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 3,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].quantity).toBe(5);
    });

    it('should create separate items for same product but different variants', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: 'var-red',
        productName: 'Test Product',
        variantName: 'Red',
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440011',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: 'var-blue',
        productName: 'Test Product',
        variantName: 'Blue',
        quantity: 3,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(sale.items).toHaveLength(2);
      expect(sale.items[0].variantId).toBe('var-red');
      expect(sale.items[0].quantity).toBe(2);
      expect(sale.items[1].variantId).toBe('var-blue');
      expect(sale.items[1].quantity).toBe(3);
    });

    it('should throw if quantity is less than 1', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      expect(() =>
        sale.addItem({
          id: '550e8400-e29b-41d4-a716-446655440010',
          saleId: BASE_SALE_ID,
          productId: 'prod-001',
          variantId: null,
          productName: 'Test Product',
          variantName: null,
          quantity: 0,
          unitPriceCents: 5000,
          unitPriceCurrency: 'MXN',
        }),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe('updateItemQuantity - change quantity of existing item', () => {
    it('should update quantity of existing item', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      const itemId = '550e8400-e29b-41d4-a716-446655440010';
      sale.addItem({
        id: itemId,
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      sale.updateItemQuantity(itemId, 5);

      expect(sale.items[0].quantity).toBe(5);
    });

    it('should throw BusinessRuleViolationError if item not found', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      expect(() => sale.updateItemQuantity('nonexistent-id', 5)).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('should throw InvalidArgumentError if new quantity is less than 1', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      const itemId = '550e8400-e29b-41d4-a716-446655440010';
      sale.addItem({
        id: itemId,
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(() => sale.updateItemQuantity(itemId, 0)).toThrow(
        InvalidArgumentError,
      );
    });

    it('should keep discount metadata unchanged when quantity changes', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      const itemId = '550e8400-e29b-41d4-a716-446655440012';
      sale.addItem({
        id: itemId,
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      sale.applyItemDiscount(itemId, {
        type: 'percentage',
        percent: 10,
        discountTitle: 'Promo',
      });

      const discountBeforeUpdate = {
        discountType: sale.items[0].discountType,
        discountValue: sale.items[0].discountValue,
        discountAmountCents: sale.items[0].discountAmountCents,
        prePriceCentsBeforeDiscount: sale.items[0].prePriceCentsBeforeDiscount,
        discountTitle: sale.items[0].discountTitle,
        discountedAt: sale.items[0].discountedAt,
      };

      sale.updateItemQuantity(itemId, 5);

      expect(sale.items[0].quantity).toBe(5);
      expect(sale.items[0].discountType).toBe(discountBeforeUpdate.discountType);
      expect(sale.items[0].discountValue).toBe(discountBeforeUpdate.discountValue);
      expect(sale.items[0].discountAmountCents).toBe(
        discountBeforeUpdate.discountAmountCents,
      );
      expect(sale.items[0].prePriceCentsBeforeDiscount).toBe(
        discountBeforeUpdate.prePriceCentsBeforeDiscount,
      );
      expect(sale.items[0].discountTitle).toBe(discountBeforeUpdate.discountTitle);
      expect(sale.items[0].discountedAt).toBe(discountBeforeUpdate.discountedAt);
    });
  });

  describe('clearItems - remove all items from sale', () => {
    it('should remove all items from sale', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Product 1',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440011',
        saleId: BASE_SALE_ID,
        productId: 'prod-002',
        variantId: null,
        productName: 'Product 2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 3000,
        unitPriceCurrency: 'MXN',
      });

      expect(sale.items).toHaveLength(2);

      sale.clearItems();

      expect(sale.items).toHaveLength(0);
    });

    it('should be idempotent when sale already empty', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.clearItems();
      expect(sale.items).toHaveLength(0);

      sale.clearItems();
      expect(sale.items).toHaveLength(0);
    });
  });

  describe('toResponse - convert to API response', () => {
    it('should return response with all sale fields', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      const response = sale.toResponse();

      expect(response.id).toBe(BASE_SALE_ID);
      expect(response.userId).toBe(USER_ID);
      expect(response.status).toBe('DRAFT');
      expect(response.items).toHaveLength(1);
      expect(response.items[0].productId).toBe('prod-001');
      expect(response.items[0].quantity).toBe(2);
    });
  });

  describe('overrideItemPrice', () => {
    it('should delegate override to selected item', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      const itemId = '550e8400-e29b-41d4-a716-446655440010';
      sale.addItem({
        id: itemId,
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      sale.overrideItemPrice(itemId, {
        priceCents: 4500,
        priceSource: 'price_list',
        appliedPriceListId: 'list-1',
        customPriceCents: null,
      });

      expect(sale.items[0].unitPriceCents).toBe(4500);
      expect(sale.items[0].priceSource).toBe('price_list');
    });

    it('should throw SALE_ITEM_NOT_FOUND when item is missing', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      expect(() =>
        sale.overrideItemPrice('missing-item', {
          priceCents: 4500,
          priceSource: 'price_list',
          appliedPriceListId: 'list-1',
          customPriceCents: null,
        }),
      ).toThrow(BusinessRuleViolationError);
      expect(() =>
        sale.overrideItemPrice('missing-item', {
          priceCents: 4500,
          priceSource: 'price_list',
          appliedPriceListId: 'list-1',
          customPriceCents: null,
        }),
      ).toThrow(/SALE_ITEM_NOT_FOUND/);
    });
  });

  describe('item discounts', () => {
    it('applies discount to selected item', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-discount',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      sale.applyItemDiscount('item-discount', { type: 'amount', amountCents: 100 });
      expect(sale.items[0].discountType).toBe('amount');
      expect(sale.items[0].unitPriceCents).toBe(900);
    });

    it('throws SALE_ITEM_NOT_FOUND for missing item', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      expect(() =>
        sale.applyItemDiscount('missing', { type: 'amount', amountCents: 100 }),
      ).toThrow(BusinessRuleViolationError);
    });
  });
});
