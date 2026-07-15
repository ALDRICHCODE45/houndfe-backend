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

    it('should keep imageUrl snapshot when provided', () => {
      const item = SaleItem.create({
        ...validItemData,
        imageUrl: 'https://cdn.example.com/p.png',
      });

      expect(item.imageUrl).toBe('https://cdn.example.com/p.png');
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
        imageUrl: 'https://cdn.example.com/persisted.png',
      });

      expect(item.id).toBe('550e8400-e29b-41d4-a716-446655440010');
      expect(item.quantity).toBe(2);
      expect(item.imageUrl).toBe('https://cdn.example.com/persisted.png');
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

      item.applyDiscount({
        type: 'percentage',
        percent: 20,
        discountTitle: 'Promo',
      });
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
        id: 'i1',
        saleId: 's1',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      item.applyDiscount({
        type: 'percentage',
        percent: 15,
        discountTitle: '15 off',
      });

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
        id: 'i2',
        saleId: 's1',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      item.applyDiscount({ type: 'percentage', percent: 10 });
      item.applyDiscount({ type: 'amount', amountCents: 200 });

      expect(item.unitPriceCents).toBe(800);
      expect(item.prePriceCentsBeforeDiscount).toBe(1000);
      expect(item.discountAmountCents).toBe(200);
    });

    it('rejects 100% discount', () => {
      const item = SaleItem.create({
        id: 'i3',
        saleId: 's1',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      expect(() =>
        item.applyDiscount({ type: 'percentage', percent: 100 }),
      ).toThrow(/DISCOUNT_PERCENT_INVALID/);
    });

    it('rejects amount that leaves price below 1', () => {
      const item = SaleItem.create({
        id: 'i4',
        saleId: 's1',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      expect(() =>
        item.applyDiscount({ type: 'amount', amountCents: 1000 }),
      ).toThrow(/DISCOUNT_AMOUNT_INVALID/);
    });

    it('removeDiscount restores price and is idempotent', () => {
      const item = SaleItem.create({
        id: 'i5',
        saleId: 's1',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      item.applyDiscount({ type: 'amount', amountCents: 200 });
      item.removeDiscount();
      item.removeDiscount();

      expect(item.unitPriceCents).toBe(1000);
      expect(item.discountType).toBeNull();
      expect(item.discountTitle).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Work Unit 3 — Task 3.1: promotionId on SaleItem
  //
  // Distinguishes promo-sourced discounts (applyDiscount called with
  // `promotionId`) from manual free-form discounts (applyDiscount called
  // without `promotionId`). The getter and toResponse expose the field so the
  // engine and the response payload can discriminate at recompute / preview
  // time.
  // ---------------------------------------------------------------------------
  describe('promotionId - promo-sourced vs manual free-form discount', () => {
    function createItem(): SaleItem {
      return SaleItem.create({
        id: 'i-promo',
        saleId: 's1',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
    }

    it('defaults promotionId to null on a fresh item', () => {
      const item = createItem();
      expect(item.promotionId).toBeNull();
    });

    it('treats a discount applied without promotionId as manual free-form', () => {
      const item = createItem();
      item.applyDiscount({
        type: 'percentage',
        percent: 10,
        discountTitle: 'manual override',
      });
      expect(item.discountType).toBe('percentage');
      expect(item.promotionId).toBeNull();
    });

    it('treats a discount applied with promotionId as promo-sourced', () => {
      const item = createItem();
      item.applyDiscount({
        type: 'percentage',
        percent: 15,
        discountTitle: 'Spring Promo',
        promotionId: 'promo-1',
      });
      expect(item.discountType).toBe('percentage');
      expect(item.promotionId).toBe('promo-1');
      expect(item.discountTitle).toBe('Spring Promo');
    });

    it('replaces a manual discount with a promo-sourced one (and updates promotionId)', () => {
      const item = createItem();
      item.applyDiscount({
        type: 'amount',
        amountCents: 100,
        discountTitle: 'manual',
      });
      expect(item.promotionId).toBeNull();
      item.applyDiscount({
        type: 'percentage',
        percent: 20,
        discountTitle: 'Promo X',
        promotionId: 'promo-x',
      });
      expect(item.promotionId).toBe('promo-x');
      expect(item.discountType).toBe('percentage');
      expect(item.discountTitle).toBe('Promo X');
      expect(item.discountAmountCents).toBe(200);
    });

    it('exposes promotionId via toResponse for API consumers', () => {
      const item = createItem();
      item.applyDiscount({
        type: 'amount',
        amountCents: 250,
        discountTitle: 'manual',
      });
      const manualResponse = item.toResponse();
      expect(manualResponse.promotionId).toBeNull();

      item.applyDiscount({
        type: 'percentage',
        percent: 25,
        discountTitle: 'Promo Z',
        promotionId: 'promo-z',
      });
      const promoResponse = item.toResponse();
      expect(promoResponse.promotionId).toBe('promo-z');
    });

    it('clears promotionId on removeDiscount', () => {
      const item = createItem();
      item.applyDiscount({
        type: 'amount',
        amountCents: 100,
        promotionId: 'promo-1',
      });
      expect(item.promotionId).toBe('promo-1');
      item.removeDiscount();
      expect(item.promotionId).toBeNull();
    });

    it('preserves the baseline - discount >= 1 invariant when promotionId is set', () => {
      const item = createItem();
      expect(() =>
        item.applyDiscount({
          type: 'amount',
          amountCents: 1000,
          promotionId: 'promo-too-big',
        }),
      ).toThrow(/DISCOUNT_AMOUNT_INVALID/);
    });

    it('clamps the percent range when promotionId is set', () => {
      const item = createItem();
      expect(() =>
        item.applyDiscount({
          type: 'percentage',
          percent: 100,
          promotionId: 'promo-100',
        }),
      ).toThrow(/DISCOUNT_PERCENT_INVALID/);
    });
  });

  // ---------------------------------------------------------------------------
  // Work Unit 2 — BUY_X_GET_Y whole-line reward (design.md Decision 1)
  //
  // The BXGY path is a SEPARATE method from `applyDiscount`. It BYPASSES the
  // per-unit clamp (sale-item.entity.ts:267 — `baseline − discount >= 1`) so
  // a get-unit can surface at 0c (true free). `applyDiscount`'s percentage
  // 1..99 clamp is unchanged — BXGY does not loosen PRODUCT_DISCOUNT.
  //
  // Contract:
  //   - `unitPriceCents` stays FULL (the buy-price); `prePriceCentsBeforeDiscount`
  //     equals `unitPriceCents` (EQUAL invariant — the discriminator).
  //   - `discountAmountCents` carries the WHOLE-LINE reward `R` (not per-unit).
  //   - `discountType = 'amount'` (rides the existing `amount` enum value).
  //   - `discountValue` snapshots the per-unit reward for the receipt.
  //   - `promotionId` set.
  //
  // The `isBuyXGetYReward()` discriminator (shared, column-derived) reads:
  //   `promotionId != null && discountAmountCents > 0 &&
  //    prePriceCentsBeforeDiscount != null &&
  //    unitPriceCents === prePriceCentsBeforeDiscount`.
  //
  // Traces to spec.md:97-100 + 102-106 (100% produces a true free get-unit
  // and partial percentages use the same NET representation).
  // ---------------------------------------------------------------------------
  describe('BUY_X_GET_Y reward — applyBuyXGetYReward + isBuyXGetYReward (WU2, spec.md:97-106)', () => {
    function createBxgyCandidate(): SaleItem {
      // qty 3, 1000c/unit — the canonical 2+1 example.
      return SaleItem.create({
        id: 'i-bxgy',
        saleId: 's-bxgy',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 3,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
    }

    describe('isBuyXGetYReward — discriminator', () => {
      it('returns false on a fresh item (no reward applied)', () => {
        const item = createBxgyCandidate();
        expect(item.isBuyXGetYReward()).toBe(false);
      });

      it('returns false after a non-BXGY (PRODUCT_DISCOUNT percentage) applyDiscount', () => {
        // Per-unit PD path mutates unitPriceCents DOWN (prePrice > unitPrice),
        // so the discriminator's `unitPrice === prePrice` clause is false.
        const item = createBxgyCandidate();
        item.applyDiscount({
          type: 'percentage',
          percent: 20,
          discountTitle: 'PD',
          promotionId: 'promo-pd',
        });
        expect(item.isBuyXGetYReward()).toBe(false);
        expect(item.promotionId).toBe('promo-pd');
      });

      it('returns false after a manual free-form discount (applyDiscount without promotionId)', () => {
        const item = createBxgyCandidate();
        item.applyDiscount({
          type: 'amount',
          amountCents: 100,
          discountTitle: 'manual',
        });
        expect(item.isBuyXGetYReward()).toBe(false);
        expect(item.promotionId).toBeNull();
      });

      it('returns true after applyBuyXGetYReward (whole-line cents, unitPrice UNCHANGED)', () => {
        const item = createBxgyCandidate();
        item.applyBuyXGetYReward({
          lineDiscountCents: 500, // R
          perUnitRewardCents: 500, // snapshot for receipt
          discountedUnitCount: 1,
          discountTitle: 'Buy 2 Get 1 @ 50%',
          promotionId: 'promo-bxgy',
        });
        expect(item.isBuyXGetYReward()).toBe(true);
      });
    });

    describe('applyBuyXGetYReward — stored state contract', () => {
      it('leaves unitPriceCents UNCHANGED (full buy-price) at 50%', () => {
        // buy 2 get 1 @ 50% on qty 3 / 1000c → R = 500c. The unit price
        // STAYS at 1000c — BXGY rides `discountAmountCents = R`, not
        // per-unit amortization. This is the discriminator invariant:
        // unitPrice === prePrice.
        const item = createBxgyCandidate();
        item.applyBuyXGetYReward({
          lineDiscountCents: 500,
          perUnitRewardCents: 500,
          discountedUnitCount: 1,
          discountTitle: 'Buy 2 Get 1 @ 50%',
          promotionId: 'promo-bxgy',
          getDiscountPercent: 50,
        });
        expect(item.unitPriceCents).toBe(1000);
        expect(item.prePriceCentsBeforeDiscount).toBe(1000);
        expect(item.unitPriceCents).toBe(item.prePriceCentsBeforeDiscount);
        // WU2 — exact promo percent stored, not derived from cents.
        expect(item.rewardDiscountPercent).toBe(50);
      });

      it('leaves unitPriceCents UNCHANGED at 100% (true free get-unit)', () => {
        // buy 2 get 1 @ 100% on qty 3 / 1000c → R = 1000c. The get-unit
        // surfaces at 0c; unitPrice still 1000c; prePrice === unitPrice;
        // discountAmountCents carries the WHOLE 1000c.
        const item = createBxgyCandidate();
        item.applyBuyXGetYReward({
          lineDiscountCents: 1000,
          perUnitRewardCents: 1000,
          discountedUnitCount: 1,
          discountTitle: 'Buy 2 Get 1 FREE',
          promotionId: 'promo-bxgy-free',
          getDiscountPercent: 100,
        });
        expect(item.unitPriceCents).toBe(1000);
        expect(item.prePriceCentsBeforeDiscount).toBe(1000);
        expect(item.discountAmountCents).toBe(1000);
        expect(item.discountValue).toBe(1000);
        expect(item.discountType).toBe('amount');
        expect(item.promotionId).toBe('promo-bxgy-free');
        // WU2 — 100% (true free) carried exactly.
        expect(item.rewardDiscountPercent).toBe(100);
      });

      it('stores discountAmountCents as the WHOLE-LINE reward R (NOT per-unit)', () => {
        // qty 6 / 1000c / buy 2 get 1 @ 50% → 2 groups × 500c per-unit = 1000c.
        // The per-unit `discountValue` is 500c (snapshot), the stored
        // `discountAmountCents` is the aggregate 1000c.
        const item = SaleItem.create({
          id: 'i-bxgy-multi',
          saleId: 's-bxgy',
          productId: 'p1',
          variantId: null,
          productName: 'P',
          variantName: null,
          quantity: 6,
          unitPriceCents: 1000,
          unitPriceCurrency: 'MXN',
        });
        item.applyBuyXGetYReward({
          lineDiscountCents: 1000,
          perUnitRewardCents: 500,
          discountedUnitCount: 2,
          discountTitle: 'Buy 2 Get 1 @ 50%',
          promotionId: 'promo-bxgy-multi',
        });
        expect(item.discountAmountCents).toBe(1000);
        expect(item.discountValue).toBe(500);
        expect(item.discountType).toBe('amount');
      });

      it('stamps discountTitle + discountedAt + promotionId', () => {
        const item = createBxgyCandidate();
        const before = new Date();
        item.applyBuyXGetYReward({
          lineDiscountCents: 500,
          perUnitRewardCents: 500,
          discountedUnitCount: 1,
          discountTitle: 'Buy 2 Get 1 @ 50%',
          promotionId: 'promo-bxgy',
        });
        const after = new Date();
        expect(item.discountTitle).toBe('Buy 2 Get 1 @ 50%');
        expect(item.promotionId).toBe('promo-bxgy');
        expect(item.discountedAt).toBeInstanceOf(Date);
        expect(item.discountedAt!.getTime()).toBeGreaterThanOrEqual(
          before.getTime(),
        );
        expect(item.discountedAt!.getTime()).toBeLessThanOrEqual(
          after.getTime() + 1,
        );
      });

      it('does NOT mutate quantity, productId, variantId, or saleId', () => {
        const item = createBxgyCandidate();
        item.applyBuyXGetYReward({
          lineDiscountCents: 500,
          perUnitRewardCents: 500,
          discountedUnitCount: 1,
          discountTitle: 'BXGY',
          promotionId: 'promo-bxgy',
        });
        expect(item.quantity).toBe(3);
        expect(item.productId).toBe('p1');
        expect(item.variantId).toBeNull();
        expect(item.saleId).toBe('s-bxgy');
      });
    });

    describe('applyBuyXGetYReward — guard rails', () => {
      it('rejects R <= 0 (zero reward is meaningless; floor yields it naturally)', () => {
        const item = createBxgyCandidate();
        expect(() =>
          item.applyBuyXGetYReward({
            lineDiscountCents: 0,
            perUnitRewardCents: 0,
            discountedUnitCount: 0,
            discountTitle: 'noop',
            promotionId: 'promo-bxgy',
          }),
        ).toThrow(/BXGY_REWARD_INVALID/);
      });

      it('rejects negative R', () => {
        const item = createBxgyCandidate();
        expect(() =>
          item.applyBuyXGetYReward({
            lineDiscountCents: -10,
            perUnitRewardCents: 500,
            discountedUnitCount: 1,
            discountTitle: 'bogus',
            promotionId: 'promo-bxgy',
          }),
        ).toThrow(/BXGY_REWARD_INVALID/);
      });

      it('rejects R >= unitPriceCents × quantity (cannot reward more than the line subtotal)', () => {
        // qty 3 × 1000c = 3000c max.
        const item = createBxgyCandidate();
        expect(() =>
          item.applyBuyXGetYReward({
            lineDiscountCents: 3000,
            perUnitRewardCents: 1000,
            discountedUnitCount: 3,
            discountTitle: 'too-much',
            promotionId: 'promo-bxgy',
          }),
        ).toThrow(/BXGY_REWARD_INVALID/);
      });

      it('accepts R = 1 (smallest non-zero reward)', () => {
        const item = createBxgyCandidate();
        item.applyBuyXGetYReward({
          lineDiscountCents: 1,
          perUnitRewardCents: 1,
          discountedUnitCount: 1,
          discountTitle: '1c off',
          promotionId: 'promo-bxgy-tiny',
        });
        expect(item.isBuyXGetYReward()).toBe(true);
        expect(item.discountAmountCents).toBe(1);
      });
    });

    describe('removeDiscount clears a BXGY reward (used by recompute clear/apply, WU4)', () => {
      it('clears all BXGY fields and discriminator flips to false', () => {
        const item = createBxgyCandidate();
        item.applyBuyXGetYReward({
          lineDiscountCents: 500,
          perUnitRewardCents: 500,
          discountedUnitCount: 1,
          discountTitle: 'BXGY',
          promotionId: 'promo-bxgy',
        });
        expect(item.isBuyXGetYReward()).toBe(true);

        item.removeDiscount();

        expect(item.isBuyXGetYReward()).toBe(false);
        expect(item.discountType).toBeNull();
        expect(item.discountValue).toBeNull();
        expect(item.discountAmountCents).toBeNull();
        expect(item.prePriceCentsBeforeDiscount).toBeNull();
        expect(item.discountTitle).toBeNull();
        expect(item.discountedAt).toBeNull();
        expect(item.promotionId).toBeNull();
        // unitPrice stays at full (it was never reduced — prePrice === unitPrice).
        expect(item.unitPriceCents).toBe(1000);
      });
    });

    describe('applyDiscount remains unchanged (regression-safe for PRODUCT_DISCOUNT path)', () => {
      it('still rejects 100% percentage discount (PRODUCT_DISCOUNT 1..99 clamp intact)', () => {
        const item = createBxgyCandidate();
        expect(() =>
          item.applyDiscount({
            type: 'percentage',
            percent: 100,
            promotionId: 'promo-pd-100',
          }),
        ).toThrow(/DISCOUNT_PERCENT_INVALID/);
      });

      it('still enforces baseline − discount >= 1 (PRODUCT_DISCOUNT path invariant intact)', () => {
        const item = createBxgyCandidate();
        expect(() =>
          item.applyDiscount({
            type: 'amount',
            amountCents: 3000,
            promotionId: 'promo-pd-full',
          }),
        ).toThrow(/DISCOUNT_AMOUNT_INVALID/);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Work Unit 8 — Draft NET per-line subtotal + rewardKind wire contract
  //
  // The DRAFT toResponse() (sale-item.entity.ts:427-450) is the path the POS
  // /wiz-pos frontend reads while the sale is still in-progress. Confirmed-
  // sale lines already expose `subtotalCents` (NET) and `rewardKind` via the
  // prisma-sale.repository mapper (see prisma-sale.repository.ts:1407,1421-1422
  // and :1437). This WU closes the contract gap so the frontend reads the
  // SAME field on both surfaces (the close-of-contract comment in the WU8
  // brief).
  //
  // Formula mirrors the receipt mapper exactly:
  //   subtotalCents = unitPriceCents * quantity
  //                   - (isBuyXGetYReward() ? (discountAmountCents ?? 0) : 0)
  //   rewardKind    = isBuyXGetYReward() ? 'buy_x_get_y' : null
  //
  // Per-unit PRODUCT_DISCOUNT path keeps `unitPrice < prePrice` so the BXGY
  // discriminator is false → R=0 → no subtraction (NET = unitPrice × qty).
  // ---------------------------------------------------------------------------
  describe('toResponse() — Draft NET subtotalCents + rewardKind (WU8)', () => {
    it('emits NET subtotalCents and rewardKind="buy_x_get_y" for a BXGY line (one true-free get-unit)', () => {
      // Per WU8 brief: unitPrice 20000, qty 2, lineDiscount 20000 → NET 20000.
      // gross would be 40000, BXGY subtracts R=20000 to render NET.
      const item = SaleItem.create({
        id: 'i-wu8-bxgy',
        saleId: 's-wu8',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 20000,
        unitPriceCurrency: 'MXN',
      });
      item.applyBuyXGetYReward({
        lineDiscountCents: 20000,
        perUnitRewardCents: 20000,
        discountedUnitCount: 1,
        discountTitle: 'Buy 1 Get 1 FREE',
        promotionId: 'promo-bxgy-bogo',
        getDiscountPercent: 100,
      });

      const response = item.toResponse();

      expect(response.subtotalCents).toBe(20000);
      expect(response.rewardKind).toBe('buy_x_get_y');
      // WU2 — the exact promo percent surfaces on the draft wire object.
      expect(response.rewardDiscountPercent).toBe(100);
    });

    it('emits NET subtotalCents and rewardKind="buy_x_get_y" for a 50% BXGY partial reward', () => {
      // qty 3 × 1000c, R=500c → NET = 3000 − 500 = 2500c.
      const item = SaleItem.create({
        id: 'i-wu8-bxgy-half',
        saleId: 's-wu8',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 3,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      item.applyBuyXGetYReward({
        lineDiscountCents: 500,
        perUnitRewardCents: 500,
        discountedUnitCount: 1,
        discountTitle: 'Buy 2 Get 1 @ 50%',
        promotionId: 'promo-bxgy-half',
        getDiscountPercent: 50,
      });

      const response = item.toResponse();

      expect(response.subtotalCents).toBe(2500);
      expect(response.rewardKind).toBe('buy_x_get_y');
      // WU2 — 50% (half) carried exactly on the draft surface.
      expect(response.rewardDiscountPercent).toBe(50);
    });

    it('emits subtotalCents = unitPrice × qty (already NET) and rewardKind=null for a per-unit PRODUCT_DISCOUNT line', () => {
      // prePrice 1000 / unitPrice 900 / qty 2 → NET = 900 × 2 = 1800. The
      // per-unit `applyDiscount` path forces unitPrice < prePrice by ≥1, so
      // the BXGY discriminator is false → R=0 → no subtraction.
      const item = SaleItem.create({
        id: 'i-wu8-pd',
        saleId: 's-wu8',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      item.applyDiscount({
        type: 'percentage',
        percent: 10,
        discountTitle: 'Promo 10%',
        promotionId: 'promo-pd',
      });

      const response = item.toResponse();

      expect(item.unitPriceCents).toBe(900);
      expect(response.subtotalCents).toBe(1800);
      expect(response.rewardKind).toBeNull();
      // WU2 — non-reward (per-unit PD) line carries null percent.
      expect(response.rewardDiscountPercent).toBeNull();
    });

    it('emits subtotalCents = unitPrice × qty (already NET) and rewardKind=null for a manual free-form discount', () => {
      // Manual free-form: no promotionId → BXGY discriminator fails the
      // first clause (promotionId !== null), so the subtraction is a no-op.
      const item = SaleItem.create({
        id: 'i-wu8-manual',
        saleId: 's-wu8',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      item.applyDiscount({
        type: 'amount',
        amountCents: 200,
        discountTitle: 'manual override',
      });

      const response = item.toResponse();

      expect(item.unitPriceCents).toBe(800);
      expect(response.subtotalCents).toBe(1600);
      expect(response.rewardKind).toBeNull();
    });

    it('emits subtotalCents = unitPrice × qty (gross = NET) and rewardKind=null for a plain line (no discount)', () => {
      const item = SaleItem.create({
        id: 'i-wu8-plain',
        saleId: 's-wu8',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 3,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      const response = item.toResponse();

      expect(response.subtotalCents).toBe(3000);
      expect(response.rewardKind).toBeNull();
      // WU2 — plain line carries null percent.
      expect(response.rewardDiscountPercent).toBeNull();
    });

    it('drops rewardKind back to null after removeDiscount clears a BXGY reward', () => {
      // After removeDiscount the BXGY discriminator returns false → rewardKind
      // must flip to null and subtotalCents must equal the un-discounted
      // `unitPriceCents × quantity`.
      const item = SaleItem.create({
        id: 'i-wu8-bxgy-removed',
        saleId: 's-wu8',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 3,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      item.applyBuyXGetYReward({
        lineDiscountCents: 500,
        perUnitRewardCents: 500,
        discountedUnitCount: 1,
        discountTitle: 'BXGY',
        promotionId: 'promo-bxgy',
        getDiscountPercent: 50,
      });
      expect(item.toResponse().rewardKind).toBe('buy_x_get_y');
      expect(item.toResponse().rewardDiscountPercent).toBe(50);

      item.removeDiscount();

      const response = item.toResponse();
      expect(response.rewardKind).toBeNull();
      // WU2 — cleared alongside rewardKind on reward reset.
      expect(response.rewardDiscountPercent).toBeNull();
      // unitPrice was never reduced by applyBuyXGetYReward (EQUAL invariant),
      // so after removeDiscount the gross/identity subtotal is `1000 * 3 = 3000`.
      expect(response.subtotalCents).toBe(3000);
    });
  });

  // ---------------------------------------------------------------------------
  // Work Unit 5 — D4 SaleItemRewardKind discriminator on the entity surface
  //
  // Slice 1 left the BXGY rail byte-identical to ADVANCED at the column level
  // (the column-derived `isBuyXGetYReward()` predicate cannot distinguish
  // them — both reuse the same `prePriceCentsBeforeDiscount === unitPriceCents
  // + promotionId set + discountAmountCents > 0` shape). WU5 adds a NEW
  // persisted enum `SaleItemRewardKind { BUY_X_GET_Y, ADVANCED }` and wires
  // it through the entity so `applyBuyXGetYReward` carries a discriminator
  // the wire can read directly. The default is `'buy_x_get_y'` (back-compat
  // for every existing BXGY call site that does not pass the new field).
  //
  // Traces to spec.md MODIFIED Requirement: rewardKind wire discriminator (D4)
  // + ADDED Requirement: ADVANCED — `rewardKind: 'advanced'` Wire Discriminator.
  // ---------------------------------------------------------------------------
  describe('WU5 — applyBuyXGetYReward rewardKind discriminator (D4)', () => {
    function createCandidate(): SaleItem {
      return SaleItem.create({
        id: 'i-wu5',
        saleId: 's-wu5',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 3,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
    }

    it('defaults to null rewardKind on a fresh item', () => {
      const item = createCandidate();
      expect(item.rewardKind).toBeNull();
      expect(item.toResponse().rewardKind).toBeNull();
    });

    it('stores rewardKind="buy_x_get_y" by default when applyBuyXGetYReward is called without the new field (back-compat)', () => {
      // Pre-Slice-2 call sites do not pass rewardKind. The entity MUST
      // default to 'buy_x_get_y' so the wire field is identical to what
      // the old `isBuyXGetYReward()` discriminator used to emit.
      const item = createCandidate();
      item.applyBuyXGetYReward({
        lineDiscountCents: 500,
        perUnitRewardCents: 500,
        discountedUnitCount: 1,
        discountTitle: 'Buy 2 Get 1 @ 50%',
        promotionId: 'promo-bxgy',
        getDiscountPercent: 50,
      });
      expect(item.rewardKind).toBe('buy_x_get_y');
      expect(item.toResponse().rewardKind).toBe('buy_x_get_y');
    });

    it('stores rewardKind="buy_x_get_y" when explicitly passed', () => {
      const item = createCandidate();
      item.applyBuyXGetYReward({
        lineDiscountCents: 1000,
        perUnitRewardCents: 1000,
        discountedUnitCount: 1,
        discountTitle: 'Buy 2 Get 1 FREE',
        promotionId: 'promo-bxgy-free',
        getDiscountPercent: 100,
        rewardKind: 'buy_x_get_y',
      });
      expect(item.rewardKind).toBe('buy_x_get_y');
      expect(item.toResponse().rewardKind).toBe('buy_x_get_y');
    });

    it('stores rewardKind="advanced" when applyBuyXGetYReward is called with the new discriminator', () => {
      // WU5 / WU6 — the Slice-1 stub at sales.service.ts:515-525 routes BOTH
      // 'buy-x-get-y' and 'advanced' engine results through applyBuyXGetYReward
      // WITHOUT the discriminator. WU6 closes that stub by passing
      // `rewardKind: 'advanced'` on the ADVANCED arm. This test pins the
      // entity contract that the new field is honored verbatim and surfaces
      // 'advanced' on the wire — so the migration of ADVANCED rows to
      // `rewardKind='advanced'` is detectable (and not silently relabeled
      // as BXGY).
      const item = createCandidate();
      item.applyBuyXGetYReward({
        lineDiscountCents: 1000,
        perUnitRewardCents: 1000,
        discountedUnitCount: 1,
        discountTitle: 'Buy 3 Get 1 @ 100% (ADVANCED)',
        promotionId: 'promo-advanced-100',
        getDiscountPercent: 100,
        rewardKind: 'advanced',
      });
      expect(item.rewardKind).toBe('advanced');
      expect(item.toResponse().rewardKind).toBe('advanced');
    });

    it('emits rewardKind="advanced" for an ADVANCED 30% multi-group reward (S2 spec scenario)', () => {
      // Spec S2 — 6 BUY units + 3 GET units, getDiscountPercent=30, 2 reward
      // groups → R = 2 * 1 * Math.round(1000*30/100) = 600c. The receipt
      // wire MUST distinguish this from a BXGY line of the same shape.
      const item = SaleItem.create({
        id: 'i-wu5-advanced-s2',
        saleId: 's-wu5',
        productId: 'p-get',
        variantId: null,
        productName: 'Holder-X',
        variantName: null,
        quantity: 3,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      item.applyBuyXGetYReward({
        lineDiscountCents: 600,
        perUnitRewardCents: 300,
        discountedUnitCount: 2,
        discountTitle: 'Buy 3 Get 1 @ 30% (ADVANCED)',
        promotionId: 'promo-advanced-s2',
        getDiscountPercent: 30,
        rewardKind: 'advanced',
      });
      expect(item.rewardKind).toBe('advanced');
      expect(item.isBuyXGetYReward()).toBe(true);
      // Wire contract: the discriminator IS the persisted kind, not the
      // column-derived shape — the test fails if the mapper falls back
      // to the legacy 'buy_x_get_y' default.
      expect(item.toResponse().rewardKind).toBe('advanced');
      // NET = 3*1000 - 600 = 2400c. BXGY formula still applies to ADVANCED
      // (same rail, different discriminator).
      expect(item.toResponse().subtotalCents).toBe(2400);
    });

    it('round-trips rewardKind="advanced" through fromPersistence (D4 wire read)', () => {
      // The receipt mapper reads the persisted column and reconstructs the
      // entity. The entity MUST expose the persisted `advanced` value on
      // the wire, not silently relabel it. This pins the read path —
      // fromPersistence is the path the persistence layer takes on reload.
      const item = SaleItem.fromPersistence({
        id: 'i-wu5-persisted',
        saleId: 's-wu5',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 3,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
        promotionId: 'promo-advanced',
        discountType: 'amount',
        discountValue: 1000,
        discountAmountCents: 1000,
        prePriceCentsBeforeDiscount: 1000,
        rewardDiscountPercent: 100,
        // The new persisted discriminator — WU5 surface.
        rewardKind: 'advanced',
      });
      expect(item.rewardKind).toBe('advanced');
      expect(item.toResponse().rewardKind).toBe('advanced');
    });

    it('round-trips rewardKind="buy_x_get_y" through fromPersistence (regression)', () => {
      // Back-compat: pre-Slice-2 BXGY rows (and the post-migration backfill)
      // persist rewardKind='BUY_X_GET_Y' (uppercase enum) on the column.
      // The mapper coerces it to the lowercase wire value.
      const item = SaleItem.fromPersistence({
        id: 'i-wu5-persisted-bxgy',
        saleId: 's-wu5',
        productId: 'p1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 3,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
        promotionId: 'promo-bxgy',
        discountType: 'amount',
        discountValue: 500,
        discountAmountCents: 500,
        prePriceCentsBeforeDiscount: 1000,
        rewardDiscountPercent: 50,
        rewardKind: 'buy_x_get_y',
      });
      expect(item.rewardKind).toBe('buy_x_get_y');
      expect(item.toResponse().rewardKind).toBe('buy_x_get_y');
    });

    it('clears rewardKind on removeDiscount (mirrors rewardDiscountPercent reset)', () => {
      // recompute clear/apply loop relies on this: a stale rewardKind on
      // the next recompute would mislabel a non-reward line as BXGY or
      // ADVANCED. The clear contract MUST wipe every reward field, not
      // just the discount fields.
      const item = createCandidate();
      item.applyBuyXGetYReward({
        lineDiscountCents: 1000,
        perUnitRewardCents: 1000,
        discountedUnitCount: 1,
        discountTitle: 'ADVANCED 100%',
        promotionId: 'promo-advanced',
        getDiscountPercent: 100,
        rewardKind: 'advanced',
      });
      expect(item.rewardKind).toBe('advanced');

      item.removeDiscount();

      expect(item.rewardKind).toBeNull();
      expect(item.toResponse().rewardKind).toBeNull();
      expect(item.rewardDiscountPercent).toBeNull();
    });

    it('emits rewardKind=null for a per-unit PRODUCT_DISCOUNT line (no regression on the non-reward path)', () => {
      // The new `rewardKind` field is for reward lines only. A PD line
      // (which never goes through `applyBuyXGetYReward`) MUST emit null —
      // otherwise the frontend would render a "free"/reward badge on
      // every PRODUCT_DISCOUNT line.
      const item = createCandidate();
      item.applyDiscount({
        type: 'percentage',
        percent: 20,
        discountTitle: 'PD 20%',
        promotionId: 'promo-pd',
      });
      expect(item.rewardKind).toBeNull();
      expect(item.toResponse().rewardKind).toBeNull();
    });

    it('switches rewardKind on re-apply (applyBuyXGetYReward twice — second call wins)', () => {
      // recompute re-applies on every mutation. The second call MUST
      // overwrite the first call's rewardKind (not concatenate or stack).
      // This pins the deterministic idempotent recompute contract.
      const item = createCandidate();
      item.applyBuyXGetYReward({
        lineDiscountCents: 500,
        perUnitRewardCents: 500,
        discountedUnitCount: 1,
        discountTitle: 'BXGY 50%',
        promotionId: 'promo-bxgy',
        getDiscountPercent: 50,
      });
      expect(item.rewardKind).toBe('buy_x_get_y');

      item.applyBuyXGetYReward({
        lineDiscountCents: 1000,
        perUnitRewardCents: 1000,
        discountedUnitCount: 1,
        discountTitle: 'ADVANCED 100%',
        promotionId: 'promo-advanced',
        getDiscountPercent: 100,
        rewardKind: 'advanced',
      });
      expect(item.rewardKind).toBe('advanced');
      expect(item.toResponse().rewardKind).toBe('advanced');
    });
  });
});
