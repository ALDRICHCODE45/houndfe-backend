import { Promotion } from './promotion.entity';
import { InvalidArgumentError } from '../../shared/domain/domain-error';

const BASE_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('Promotion Entity', () => {
  // ============================================================
  // PRODUCT_DISCOUNT
  // ============================================================
  describe('create — PRODUCT_DISCOUNT', () => {
    const validProductDiscount = {
      id: BASE_ID,
      title: '15% en Electrónica',
      type: 'PRODUCT_DISCOUNT' as const,
      method: 'AUTOMATIC' as const,
      discountType: 'PERCENTAGE' as const,
      discountValue: 15,
      appliesTo: 'CATEGORIES' as const,
    };

    it('should create a PRODUCT_DISCOUNT with required fields', () => {
      const promo = Promotion.create(validProductDiscount);
      expect(promo.id).toBe(BASE_ID);
      expect(promo.title).toBe('15% en Electrónica');
      expect(promo.type).toBe('PRODUCT_DISCOUNT');
      expect(promo.method).toBe('AUTOMATIC');
      expect(promo.discountType).toBe('PERCENTAGE');
      expect(promo.discountValue).toBe(15);
      expect(promo.appliesTo).toBe('CATEGORIES');
      expect(promo.status).toBe('ACTIVE');
      expect(promo.customerScope).toBe('ALL');
    });

    it('should default startDate/endDate to null and customerScope to ALL', () => {
      const promo = Promotion.create(validProductDiscount);
      expect(promo.startDate).toBeNull();
      expect(promo.endDate).toBeNull();
      expect(promo.customerScope).toBe('ALL');
    });

    it('should throw if title is empty', () => {
      expect(() =>
        Promotion.create({ ...validProductDiscount, title: '' }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if discountType is missing for PRODUCT_DISCOUNT', () => {
      expect(() =>
        Promotion.create({
          ...validProductDiscount,
          discountType: undefined,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if discountValue is missing for PRODUCT_DISCOUNT', () => {
      expect(() =>
        Promotion.create({
          ...validProductDiscount,
          discountValue: undefined,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if appliesTo is missing for PRODUCT_DISCOUNT', () => {
      expect(() =>
        Promotion.create({
          ...validProductDiscount,
          appliesTo: undefined,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if PERCENTAGE discountValue > 100', () => {
      expect(() =>
        Promotion.create({
          ...validProductDiscount,
          discountType: 'PERCENTAGE',
          discountValue: 150,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if PERCENTAGE discountValue < 1', () => {
      expect(() =>
        Promotion.create({
          ...validProductDiscount,
          discountType: 'PERCENTAGE',
          discountValue: 0,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if FIXED discountValue <= 0', () => {
      expect(() =>
        Promotion.create({
          ...validProductDiscount,
          discountType: 'FIXED',
          discountValue: 0,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if forbidden field buyQuantity is present for PRODUCT_DISCOUNT', () => {
      expect(() =>
        Promotion.create({
          ...validProductDiscount,
          buyQuantity: 2,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if forbidden field minPurchaseAmountCents is present for PRODUCT_DISCOUNT', () => {
      expect(() =>
        Promotion.create({
          ...validProductDiscount,
          minPurchaseAmountCents: 1000,
        }),
      ).toThrow(InvalidArgumentError);
    });
  });

  // ============================================================
  // ORDER_DISCOUNT
  // ============================================================
  describe('create — ORDER_DISCOUNT', () => {
    const validOrderDiscount = {
      id: BASE_ID,
      title: '10% en pedidos',
      type: 'ORDER_DISCOUNT' as const,
      method: 'MANUAL' as const,
      discountType: 'PERCENTAGE' as const,
      discountValue: 10,
    };

    it('should create an ORDER_DISCOUNT with required fields', () => {
      const promo = Promotion.create(validOrderDiscount);
      expect(promo.type).toBe('ORDER_DISCOUNT');
      expect(promo.discountType).toBe('PERCENTAGE');
      expect(promo.discountValue).toBe(10);
      expect(promo.appliesTo).toBeNull();
      expect(promo.minPurchaseAmountCents).toBeNull();
    });

    it('should allow optional minPurchaseAmountCents for ORDER_DISCOUNT', () => {
      const promo = Promotion.create({
        ...validOrderDiscount,
        minPurchaseAmountCents: 5000,
      });
      expect(promo.minPurchaseAmountCents).toBe(5000);
    });

    it('should throw if forbidden field appliesTo is present for ORDER_DISCOUNT', () => {
      expect(() =>
        Promotion.create({
          ...validOrderDiscount,
          appliesTo: 'PRODUCTS' as const,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if forbidden field buyQuantity is present for ORDER_DISCOUNT', () => {
      expect(() =>
        Promotion.create({
          ...validOrderDiscount,
          buyQuantity: 1,
        }),
      ).toThrow(InvalidArgumentError);
    });
  });

  // ============================================================
  // BUY_X_GET_Y
  // ============================================================
  describe('create — BUY_X_GET_Y', () => {
    const validBuyXGetY = {
      id: BASE_ID,
      title: '2x1 en snacks',
      type: 'BUY_X_GET_Y' as const,
      method: 'AUTOMATIC' as const,
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 0,
    };

    it('should create a BUY_X_GET_Y with required fields', () => {
      const promo = Promotion.create(validBuyXGetY);
      expect(promo.type).toBe('BUY_X_GET_Y');
      expect(promo.buyQuantity).toBe(2);
      expect(promo.getQuantity).toBe(1);
      expect(promo.getDiscountPercent).toBe(0);
      expect(promo.discountType).toBeNull();
      expect(promo.discountValue).toBeNull();
    });

    it('should allow optional appliesTo for BUY_X_GET_Y', () => {
      const promo = Promotion.create({
        ...validBuyXGetY,
        appliesTo: 'PRODUCTS' as const,
      });
      expect(promo.appliesTo).toBe('PRODUCTS');
    });

    it('should throw if buyQuantity < 1 for BUY_X_GET_Y', () => {
      expect(() =>
        Promotion.create({ ...validBuyXGetY, buyQuantity: 0 }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if getQuantity < 1 for BUY_X_GET_Y', () => {
      expect(() =>
        Promotion.create({ ...validBuyXGetY, getQuantity: 0 }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if getDiscountPercent > 99 for BUY_X_GET_Y', () => {
      expect(() =>
        Promotion.create({ ...validBuyXGetY, getDiscountPercent: 100 }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if getDiscountPercent < 0 for BUY_X_GET_Y', () => {
      expect(() =>
        Promotion.create({ ...validBuyXGetY, getDiscountPercent: -1 }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if forbidden discountType is present for BUY_X_GET_Y', () => {
      expect(() =>
        Promotion.create({
          ...validBuyXGetY,
          discountType: 'PERCENTAGE' as const,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if forbidden discountValue is present for BUY_X_GET_Y', () => {
      expect(() =>
        Promotion.create({ ...validBuyXGetY, discountValue: 10 }),
      ).toThrow(InvalidArgumentError);
    });
  });

  // ============================================================
  // ADVANCED
  // ============================================================
  describe('create — ADVANCED', () => {
    const validAdvanced = {
      id: BASE_ID,
      title: 'Compra X lleva Y',
      type: 'ADVANCED' as const,
      method: 'AUTOMATIC' as const,
      buyQuantity: 1,
      getQuantity: 1,
      getDiscountPercent: 0,
    };

    it('should create an ADVANCED promotion with required fields', () => {
      const promo = Promotion.create(validAdvanced);
      expect(promo.type).toBe('ADVANCED');
      expect(promo.buyQuantity).toBe(1);
      expect(promo.getQuantity).toBe(1);
      expect(promo.getDiscountPercent).toBe(0);
      expect(promo.buyTargetType).toBeNull();
      expect(promo.getTargetType).toBeNull();
      expect(promo.appliesTo).toBeNull();
    });

    it('should allow optional buyTargetType and getTargetType for ADVANCED', () => {
      const promo = Promotion.create({
        ...validAdvanced,
        buyTargetType: 'BRANDS' as const,
        getTargetType: 'CATEGORIES' as const,
      });
      expect(promo.buyTargetType).toBe('BRANDS');
      expect(promo.getTargetType).toBe('CATEGORIES');
    });

    it('should throw if forbidden appliesTo is present for ADVANCED', () => {
      expect(() =>
        Promotion.create({
          ...validAdvanced,
          appliesTo: 'CATEGORIES' as const,
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw if forbidden discountType is present for ADVANCED', () => {
      expect(() =>
        Promotion.create({
          ...validAdvanced,
          discountType: 'FIXED' as const,
        }),
      ).toThrow(InvalidArgumentError);
    });
  });

  // ============================================================
  // DATE VALIDATION
  // ============================================================
  describe('create — date validation', () => {
    const validBase = {
      id: BASE_ID,
      title: 'Test',
      type: 'ORDER_DISCOUNT' as const,
      method: 'AUTOMATIC' as const,
      discountType: 'PERCENTAGE' as const,
      discountValue: 10,
    };

    it('should throw if endDate < startDate', () => {
      const start = new Date('2026-06-01');
      const end = new Date('2026-05-01');
      expect(() =>
        Promotion.create({ ...validBase, startDate: start, endDate: end }),
      ).toThrow(InvalidArgumentError);
    });

    it('should allow endDate >= startDate', () => {
      const start = new Date('2026-05-01');
      const end = new Date('2026-06-01');
      const promo = Promotion.create({
        ...validBase,
        startDate: start,
        endDate: end,
      });
      expect(promo.startDate).toEqual(start);
      expect(promo.endDate).toEqual(end);
    });
  });

  // ============================================================
  // CUSTOMER SCOPE VALIDATION
  // ============================================================
  describe('create — customerScope SPECIFIC validation', () => {
    const validBase = {
      id: BASE_ID,
      title: 'Test',
      type: 'ORDER_DISCOUNT' as const,
      method: 'AUTOMATIC' as const,
      discountType: 'PERCENTAGE' as const,
      discountValue: 10,
    };

    it('should default customerScope to ALL', () => {
      const promo = Promotion.create(validBase);
      expect(promo.customerScope).toBe('ALL');
    });

    it('should set customerScope to SPECIFIC when provided', () => {
      const promo = Promotion.create({
        ...validBase,
        customerScope: 'SPECIFIC' as const,
      });
      expect(promo.customerScope).toBe('SPECIFIC');
    });
  });

  // ============================================================
  // STATUS DERIVATION
  // ============================================================
  describe('getEffectiveStatus', () => {
    const validBase = {
      id: BASE_ID,
      title: 'Test',
      type: 'ORDER_DISCOUNT' as const,
      method: 'AUTOMATIC' as const,
      discountType: 'PERCENTAGE' as const,
      discountValue: 10,
    };

    it('should return ACTIVE when no startDate and no endDate', () => {
      const promo = Promotion.create(validBase);
      expect(promo.getEffectiveStatus(new Date())).toBe('ACTIVE');
    });

    it('should return SCHEDULED when startDate is in the future', () => {
      const futureStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const promo = Promotion.create({ ...validBase, startDate: futureStart });
      expect(promo.getEffectiveStatus(new Date())).toBe('SCHEDULED');
    });

    it('should return ENDED when endDate is in the past', () => {
      const pastEnd = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const pastStart = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const promo = Promotion.create({
        ...validBase,
        startDate: pastStart,
        endDate: pastEnd,
      });
      expect(promo.getEffectiveStatus(new Date())).toBe('ENDED');
    });

    it('should return ACTIVE when startDate is in the past and no endDate', () => {
      const pastStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const promo = Promotion.create({ ...validBase, startDate: pastStart });
      expect(promo.getEffectiveStatus(new Date())).toBe('ACTIVE');
    });

    it('should return ENDED when status is manually ENDED even if dates are valid', () => {
      const promo = Promotion.create(validBase);
      promo.end();
      expect(promo.getEffectiveStatus(new Date())).toBe('ENDED');
    });
  });

  // ============================================================
  // end() METHOD
  // ============================================================
  describe('end()', () => {
    it('should set status to ENDED', () => {
      const promo = Promotion.create({
        id: BASE_ID,
        title: 'Test',
        type: 'ORDER_DISCOUNT' as const,
        method: 'AUTOMATIC' as const,
        discountType: 'PERCENTAGE' as const,
        discountValue: 10,
      });
      expect(promo.status).toBe('ACTIVE');
      promo.end();
      expect(promo.status).toBe('ENDED');
    });

    it('should set endDate to now if endDate was null', () => {
      const promo = Promotion.create({
        id: BASE_ID,
        title: 'Test',
        type: 'ORDER_DISCOUNT' as const,
        method: 'AUTOMATIC' as const,
        discountType: 'PERCENTAGE' as const,
        discountValue: 10,
      });
      expect(promo.endDate).toBeNull();
      const before = new Date();
      promo.end();
      const after = new Date();
      expect(promo.endDate).not.toBeNull();
      expect(promo.endDate!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(promo.endDate!.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should be idempotent — calling end() twice keeps ENDED', () => {
      const promo = Promotion.create({
        id: BASE_ID,
        title: 'Test',
        type: 'ORDER_DISCOUNT' as const,
        method: 'AUTOMATIC' as const,
        discountType: 'PERCENTAGE' as const,
        discountValue: 10,
      });
      promo.end();
      promo.end();
      expect(promo.status).toBe('ENDED');
    });
  });

  // ============================================================
  // fromPersistence
  // ============================================================
  describe('fromPersistence', () => {
    it('should reconstruct entity from persistence data', () => {
      const now = new Date();
      const promo = Promotion.fromPersistence({
        id: BASE_ID,
        title: 'Persisted Promo',
        type: 'PRODUCT_DISCOUNT',
        method: 'MANUAL',
        status: 'ACTIVE',
        startDate: null,
        endDate: null,
        customerScope: 'ALL',
        discountType: 'FIXED',
        discountValue: 5000,
        minPurchaseAmountCents: null,
        appliesTo: 'PRODUCTS',
        buyQuantity: null,
        getQuantity: null,
        getDiscountPercent: null,
        buyTargetType: null,
        getTargetType: null,
        createdAt: now,
        updatedAt: now,
        targetItems: [],
        customers: [],
        priceLists: [],
        daysOfWeek: [],
      });

      expect(promo.id).toBe(BASE_ID);
      expect(promo.title).toBe('Persisted Promo');
      expect(promo.type).toBe('PRODUCT_DISCOUNT');
      expect(promo.discountValue).toBe(5000);
      expect(promo.appliesTo).toBe('PRODUCTS');
    });

    it('should preserve ENDED status from persistence (manual override)', () => {
      const now = new Date();
      const promo = Promotion.fromPersistence({
        id: BASE_ID,
        title: 'Ended Promo',
        type: 'ORDER_DISCOUNT',
        method: 'MANUAL',
        status: 'ENDED',
        startDate: null,
        endDate: now,
        customerScope: 'ALL',
        discountType: 'PERCENTAGE',
        discountValue: 10,
        minPurchaseAmountCents: null,
        appliesTo: null,
        buyQuantity: null,
        getQuantity: null,
        getDiscountPercent: null,
        buyTargetType: null,
        getTargetType: null,
        createdAt: now,
        updatedAt: now,
        targetItems: [],
        customers: [],
        priceLists: [],
        daysOfWeek: [],
      });

      expect(promo.getEffectiveStatus(new Date())).toBe('ENDED');
    });
  });

  // ============================================================
  // toResponse
  // ============================================================
  describe('toResponse()', () => {
    it('should include all fields in response with ISO string dates', () => {
      const promo = Promotion.create({
        id: BASE_ID,
        title: 'Response Test',
        type: 'ORDER_DISCOUNT' as const,
        method: 'AUTOMATIC' as const,
        discountType: 'PERCENTAGE' as const,
        discountValue: 20,
      });

      const response = promo.toResponse(new Date());
      expect(response.id).toBe(BASE_ID);
      expect(response.title).toBe('Response Test');
      expect(response.type).toBe('ORDER_DISCOUNT');
      expect(response.status).toBe('ACTIVE');
      expect(typeof response.createdAt).toBe('string');
      expect(typeof response.updatedAt).toBe('string');
      expect(response.targetItems).toEqual([]);
      expect(response.customers).toEqual([]);
      expect(response.priceLists).toEqual([]);
      expect(response.daysOfWeek).toEqual([]);
    });
  });
});
