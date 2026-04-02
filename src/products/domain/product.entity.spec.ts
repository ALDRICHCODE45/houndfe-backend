import { Product } from './product.entity';
import {
  InvalidArgumentError,
  BusinessRuleViolationError,
} from '../../shared/domain/domain-error';

describe('Product Entity', () => {
  const validParams = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Test Product',
  };

  describe('create', () => {
    it('should create a product with defaults', () => {
      const product = Product.create(validParams);
      expect(product.id).toBe(validParams.id);
      expect(product.name.productName).toBe('Test Product');
      expect(product.location).toBeNull();
      expect(product.description).toBeNull();
      expect(product.type).toBe('PRODUCT');
      expect(product.sku).toBeNull();
      expect(product.barcode).toBeNull();
      expect(product.unit).toBe('UNIDAD');
      expect(product.sellInPos).toBe(true);
      expect(product.includeInOnlineCatalog).toBe(true);
      expect(product.useStock).toBe(true);
      expect(product.chargeProductTaxes).toBe(true);
      expect(product.ivaRate.value).toBe('IVA_16');
      expect(product.iepsRate.value).toBe('NO_APLICA');
      expect(product.purchaseCost.netCents).toBe(0);
      expect(product.purchaseCost.grossCents).toBe(0);
      expect(product.quantity).toBe(0);
      expect(product.minQuantity).toBe(0);
      expect(product.hasVariants).toBe(false);
    });

    it('should create with all explicit params', () => {
      const product = Product.create({
        ...validParams,
        type: 'SERVICE',
        sku: 'abc-123',
        location: 'A1',
        description: 'Producto de prueba',
        barcode: '7501234567890',
        unit: 'KILOGRAMO',
        satKey: '01010101',
        categoryId: 'cat-id',
        sellInPos: false,
        includeInOnlineCatalog: false,
        chargeProductTaxes: false,
        ivaRate: 'IVA_8',
        iepsRate: 'IEPS_8',
        purchaseCostMode: 'NET',
        purchaseCostValue: 10000, // 100.00 MXN
        useStock: false,
        quantity: 50,
        minQuantity: 5,
        hasVariants: true,
      });

      expect(product.type).toBe('SERVICE');
      expect(product.sku).toBe('ABC-123'); // uppercased
      expect(product.location).toBe('A1');
      expect(product.description).toBe('Producto de prueba');
      expect(product.barcode).toBe('7501234567890');
      expect(product.unit).toBe('KILOGRAMO');
      expect(product.ivaRate.value).toBe('IVA_8');
      expect(product.iepsRate.value).toBe('IEPS_8');
      expect(product.purchaseCost.netCents).toBe(10000);
      // gross = net * (1 + 0.08 + 0.08) = 10000 * 1.16 = 11600
      expect(product.purchaseCost.grossCents).toBe(11600);
      expect(product.hasVariants).toBe(true);
    });

    it('should throw on empty name', () => {
      expect(() => Product.create({ ...validParams, name: '' })).toThrow(
        InvalidArgumentError,
      );
    });

    it('should throw on negative quantity', () => {
      expect(() => Product.create({ ...validParams, quantity: -1 })).toThrow(
        InvalidArgumentError,
      );
    });

    it('should disable lots and direct quantities when hasVariants=true', () => {
      const product = Product.create({
        ...validParams,
        hasVariants: true,
        useLotsAndExpirations: true,
        quantity: 20,
        minQuantity: 4,
      });

      expect(product.useLotsAndExpirations).toBe(false);
      expect(product.quantity).toBe(0);
      expect(product.minQuantity).toBe(0);
    });

    it('should disable lots and direct quantities when useStock=false', () => {
      const product = Product.create({
        ...validParams,
        useStock: false,
        useLotsAndExpirations: true,
        quantity: 20,
        minQuantity: 4,
      });

      expect(product.useLotsAndExpirations).toBe(false);
      expect(product.quantity).toBe(0);
      expect(product.minQuantity).toBe(0);
    });

    it('should zero direct quantities when useLotsAndExpirations=true', () => {
      const product = Product.create({
        ...validParams,
        useLotsAndExpirations: true,
        quantity: 12,
        minQuantity: 3,
      });

      expect(product.quantity).toBe(0);
      expect(product.minQuantity).toBe(3);
    });
  });

  describe('decreaseStock', () => {
    it('should decrease stock', () => {
      const product = Product.create({
        ...validParams,
        quantity: 10,
      });
      product.decreaseStock(3);
      expect(product.quantity).toBe(7);
    });

    it('should throw on insufficient stock', () => {
      const product = Product.create({
        ...validParams,
        quantity: 2,
      });
      expect(() => product.decreaseStock(5)).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('should throw when product has variants', () => {
      const product = Product.create({
        ...validParams,
        hasVariants: true,
      });
      expect(() => product.decreaseStock(1)).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('should throw on non-positive quantity', () => {
      const product = Product.create({
        ...validParams,
        quantity: 10,
      });
      expect(() => product.decreaseStock(0)).toThrow(InvalidArgumentError);
      expect(() => product.decreaseStock(-1)).toThrow(InvalidArgumentError);
    });
  });

  describe('increaseStock', () => {
    it('should increase stock', () => {
      const product = Product.create({
        ...validParams,
        quantity: 5,
      });
      product.increaseStock(3);
      expect(product.quantity).toBe(8);
    });

    it('should throw when product has variants', () => {
      const product = Product.create({
        ...validParams,
        hasVariants: true,
      });
      expect(() => product.increaseStock(1)).toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('canSell', () => {
    it('should return true when useStock=false', () => {
      const product = Product.create({
        ...validParams,
        useStock: false,
        quantity: 0,
      });
      expect(product.canSell(100)).toBe(true);
    });

    it('should check stock when useStock=true', () => {
      const product = Product.create({
        ...validParams,
        quantity: 5,
      });
      expect(product.canSell(5)).toBe(true);
      expect(product.canSell(6)).toBe(false);
    });
  });

  describe('toPersistence / toResponse', () => {
    it('should serialize to persistence format', () => {
      const product = Product.create(validParams);
      const p = product.toPersistence();
      expect(p.name).toBe('Test Product');
      expect(p.type).toBe('PRODUCT');
      expect(p.ivaRate).toBe('IVA_16');
      expect(p.iepsRate).toBe('NO_APLICA');
    });

    it('should serialize to response format', () => {
      const product = Product.create(validParams);
      const r = product.toResponse();
      expect(r.name).toBe('Test Product');
      expect(r.purchaseCost.mode).toBe('NET');
      expect(typeof r.createdAt).toBe('string');
    });
  });

  describe('fromPersistence', () => {
    it('should reconstruct from persistence data', () => {
      const product = Product.create({
        ...validParams,
        sku: 'SKU-001',
        ivaRate: 'IVA_0',
      });
      const persisted = product.toPersistence();

      const reconstructed = Product.fromPersistence({
        ...persisted,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(reconstructed.id).toBe(product.id);
      expect(reconstructed.sku).toBe('SKU-001');
      expect(reconstructed.ivaRate.value).toBe('IVA_0');
    });
  });
});
