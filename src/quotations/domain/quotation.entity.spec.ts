/**
 * Quotation Entity — Unit Tests (RED phase)
 *
 * Covers T001, T002, T004:
 *   - Quotation.create() factory validation
 *   - Quotation.fromPersistence() reconstruction
 *   - Lifecycle guards (addItem, removeItem, cancel, status transitions,
 *     lazy expiry via getEffectiveStatus)
 */
import { Quotation } from './quotation.entity';
import { QuotationItem } from './quotation-item.entity';
import { InvalidArgumentError, BusinessRuleViolationError } from '../../shared/domain/domain-error';

const TENANT = 'tenant-1';
const SELLER = 'seller-1';

const newQuotationId = () => 'q-' + Math.random().toString(36).slice(2, 10);
const newItemId = () => 'item-' + Math.random().toString(36).slice(2, 10);

const validItemProps = (id = newItemId(), overrides: Record<string, unknown> = {}) => ({
  id,
  quotationId: 'ignored-by-entity',
  productId: 'prod-001',
  variantId: null,
  productName: 'Test Product',
  variantName: null,
  quantity: 2,
  unitPriceCents: 5000,
  unitPriceCurrency: 'MXN',
  ...overrides,
});

describe('Quotation Entity', () => {
  describe('create — factory validation (T001)', () => {
    it('should create a DRAFT quotation with defaults', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });

      expect(q.id).toBeDefined();
      expect(q.sellerUserId).toBe(SELLER);
      expect(q.status).toBe('DRAFT');
      expect(q.subtotalCents).toBe(0);
      expect(q.discountCents).toBe(0);
      expect(q.totalCents).toBe(0);
      expect(q.manuallyEnded).toBe(false);
      expect(q.items).toEqual([]);
      expect(q.customerId).toBeNull();
      expect(q.globalPriceListId).toBeNull();
      expect(q.expiresAt).toBeNull();
      expect(q.cancelReason).toBeNull();
    });

    it('should accept optional customerId and globalPriceListId on create', () => {
      const q = Quotation.create({
        id: newQuotationId(),
        sellerUserId: SELLER,
        customerId: 'cust-1',
        globalPriceListId: 'pl-1',
      });

      expect(q.customerId).toBe('cust-1');
      expect(q.globalPriceListId).toBe('pl-1');
    });

    it('should throw InvalidArgumentError when id is empty', () => {
      expect(() =>
        Quotation.create({ id: '', sellerUserId: SELLER }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError when sellerUserId is empty', () => {
      expect(() =>
        Quotation.create({ id: newQuotationId(), sellerUserId: '' }),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe('fromPersistence — round-trip (T002)', () => {
    it('should reconstitute a quotation with all persisted fields', () => {
      const now = new Date('2026-07-15T12:00:00Z');
      const later = new Date('2026-07-16T12:00:00Z');

      const q = Quotation.fromPersistence({
        id: 'q-1',
        sellerUserId: SELLER,
        customerId: 'cust-1',
        globalPriceListId: 'pl-1',
        priceListExplicitlySet: true,
        status: 'SENT',
        expiresAt: new Date('2026-12-31T23:59:59Z'),
        cancelReason: null,
        subtotalCents: 20000,
        discountCents: 2000,
        totalCents: 18000,
        manuallyEnded: false,
        items: [
          {
            id: 'item-1',
            quotationId: 'q-1',
            productId: 'prod-001',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 4,
            unitPriceCents: 5000,
            unitPriceCurrency: 'MXN',
          },
        ],
        vetoedPromotionIds: ['promo-A'],
        optedInManualPromotionIds: ['promo-M'],
        createdAt: now,
        updatedAt: later,
      });

      expect(q.id).toBe('q-1');
      expect(q.sellerUserId).toBe(SELLER);
      expect(q.customerId).toBe('cust-1');
      expect(q.globalPriceListId).toBe('pl-1');
      expect(q.priceListExplicitlySet).toBe(true);
      expect(q.status).toBe('SENT');
      expect(q.expiresAt).toEqual(new Date('2026-12-31T23:59:59Z'));
      expect(q.subtotalCents).toBe(20000);
      expect(q.discountCents).toBe(2000);
      expect(q.totalCents).toBe(18000);
      expect(q.items).toHaveLength(1);
      expect(q.items[0]?.productId).toBe('prod-001');
      expect(q.vetoedPromotionIds).toEqual(['promo-A']);
      expect(q.optedInManualPromotionIds).toEqual(['promo-M']);
      expect(q.createdAt).toEqual(now);
      expect(q.updatedAt).toEqual(later);
    });

    it('should default missing optional fields to null / empty', () => {
      const q = Quotation.fromPersistence({
        id: 'q-1',
        sellerUserId: SELLER,
        customerId: null,
        globalPriceListId: null,
        priceListExplicitlySet: false,
        status: 'DRAFT',
        expiresAt: null,
        cancelReason: null,
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        manuallyEnded: false,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(q.customerId).toBeNull();
      expect(q.globalPriceListId).toBeNull();
      expect(q.priceListExplicitlySet).toBe(false);
      expect(q.expiresAt).toBeNull();
      expect(q.items).toEqual([]);
    });
  });

  describe('lifecycle — addItem / removeItem / clearItems / updateItemQuantity (T004)', () => {
    it('addItem appends a new item to an empty draft', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addItem(validItemProps('item-1'));

      expect(q.items).toHaveLength(1);
      expect(q.items[0]?.productId).toBe('prod-001');
    });

    it('addItem stacks quantities when product+variant matches', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addItem(validItemProps('item-1', { quantity: 2 }));
      q.addItem(validItemProps('item-2', { quantity: 3 }));

      expect(q.items).toHaveLength(1);
      expect(q.items[0]?.quantity).toBe(5);
    });

    it('updateItemQuantity changes the quantity of an existing item', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addItem(validItemProps('item-1', { quantity: 2 }));
      q.updateItemQuantity('item-1', 7);

      expect(q.items[0]?.quantity).toBe(7);
    });

    it('updateItemQuantity throws when new qty < 1', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addItem(validItemProps('item-1'));

      expect(() => q.updateItemQuantity('item-1', 0)).toThrow(
        InvalidArgumentError,
      );
    });

    it('updateItemQuantity throws when item is not found', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      expect(() => q.updateItemQuantity('missing', 5)).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('removeItem removes the matching item', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addItem(validItemProps('item-1'));
      q.addItem(validItemProps('item-2', { productId: 'prod-002' }));

      q.removeItem('item-1');

      expect(q.items).toHaveLength(1);
      expect(q.items[0]?.id).toBe('item-2');
    });

    it('removeItem throws when item is not found', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      expect(() => q.removeItem('missing')).toThrow(BusinessRuleViolationError);
    });

    it('clearItems empties the items array', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addItem(validItemProps('item-1'));
      q.addItem(validItemProps('item-2'));
      q.clearItems();
      expect(q.items).toEqual([]);
    });
  });

  describe('lifecycle — cancel + idempotency (T004)', () => {
    it('cancel flips a DRAFT quotation to CANCELLED with the given reason', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      const canceledAt = new Date('2026-07-15T10:00:00Z');

      const cancelled = q.cancel('CUSTOMER_REQUEST', canceledAt);

      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelReason).toBe('CUSTOMER_REQUEST');
      expect(cancelled.canceledAt).toEqual(canceledAt);
      // Original instance is unchanged (immutable pattern for status transitions)
      expect(q.status).toBe('DRAFT');
    });

    it('cancel is idempotent when called twice on the same quotation', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      const once = q.cancel('PRICE_OBJECTION', new Date('2026-07-15T10:00:00Z'));
      const twice = once.cancel('OTHER', new Date('2026-07-16T10:00:00Z'));

      // First cancel sets the canonical cancelReason and canceledAt
      expect(once.status).toBe('CANCELLED');
      expect(once.cancelReason).toBe('PRICE_OBJECTION');
      expect(once.canceledAt).toEqual(new Date('2026-07-15T10:00:00Z'));

      // Second cancel is a no-op — returns the same canonical values
      expect(twice).toBe(once);
    });

    it('cancel can transition from SENT to CANCELLED', () => {
      const sent = Quotation.fromPersistence({
        id: 'q-1',
        sellerUserId: SELLER,
        customerId: null,
        globalPriceListId: null,
        priceListExplicitlySet: false,
        status: 'SENT',
        expiresAt: null,
        cancelReason: null,
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        manuallyEnded: false,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const cancelled = sent.cancel('OTHER');
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  describe('lifecycle — status guards (T004)', () => {
    const sentQuotation = () =>
      Quotation.fromPersistence({
        id: 'q-sent',
        sellerUserId: SELLER,
        customerId: null,
        globalPriceListId: null,
        priceListExplicitlySet: false,
        status: 'SENT',
        expiresAt: null,
        cancelReason: null,
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        manuallyEnded: false,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    it('addItem throws on non-DRAFT quotation', () => {
      const q = sentQuotation();
      expect(() => q.addItem(validItemProps())).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('removeItem throws on non-DRAFT quotation', () => {
      const q = sentQuotation();
      expect(() => q.removeItem('any')).toThrow(BusinessRuleViolationError);
    });

    it('clearItems throws on non-DRAFT quotation', () => {
      const q = sentQuotation();
      expect(() => q.clearItems()).toThrow(BusinessRuleViolationError);
    });

    it('updateItemQuantity throws on non-DRAFT quotation', () => {
      const q = sentQuotation();
      expect(() => q.updateItemQuantity('any', 1)).toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('lifecycle — assignCustomer + setGlobalPriceList', () => {
    it('assignCustomer sets customerId and (optionally) auto-seeds price list', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.assignCustomer('cust-1', 'pl-1');
      expect(q.customerId).toBe('cust-1');
      expect(q.globalPriceListId).toBe('pl-1');
      expect(q.priceListExplicitlySet).toBe(false);
    });

    it('assignCustomer preserves cashier-explicit price list (does NOT re-seed)', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.setGlobalPriceList('pl-X', true);
      q.assignCustomer('cust-1', 'pl-1'); // cashier override in effect

      expect(q.priceListExplicitlySet).toBe(true);
      expect(q.globalPriceListId).toBe('pl-X');
    });

    it('clearCustomer resets customer and price list when not explicitly set', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.assignCustomer('cust-1', 'pl-1');
      q.clearCustomer();

      expect(q.customerId).toBeNull();
      expect(q.globalPriceListId).toBeNull();
    });

    it('setGlobalPriceList with explicit=true records the cashier override', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.setGlobalPriceList('pl-2', true);
      expect(q.globalPriceListId).toBe('pl-2');
      expect(q.priceListExplicitlySet).toBe(true);
    });

    it('setGlobalPriceList throws on non-DRAFT', () => {
      const q = Quotation.fromPersistence({
        id: 'q-sent',
        sellerUserId: SELLER,
        customerId: null,
        globalPriceListId: null,
        priceListExplicitlySet: false,
        status: 'SENT',
        expiresAt: null,
        cancelReason: null,
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        manuallyEnded: false,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(() => q.setGlobalPriceList('pl-1', true)).toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('lifecycle — promotion veto / opt-in cross-clear (T004)', () => {
    it('addVetoedPromotion adds a promotion id to the veto set', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addVetoedPromotion('promo-A');
      expect(q.vetoedPromotionIds).toEqual(['promo-A']);
    });

    it('addVetoedPromotion is idempotent', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addVetoedPromotion('promo-A');
      q.addVetoedPromotion('promo-A');
      expect(q.vetoedPromotionIds).toEqual(['promo-A']);
    });

    it('removeVetoedPromotion drops the id from the veto set', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addVetoedPromotion('promo-A');
      q.removeVetoedPromotion('promo-A');
      expect(q.vetoedPromotionIds).toEqual([]);
    });

    it('optInManualPromotion adds a promotion id to the opted-in set', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.optInManualPromotion('promo-M');
      expect(q.optedInManualPromotionIds).toEqual(['promo-M']);
    });

    it('optInManualPromotion cross-clears the veto set (reactivation path)', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addVetoedPromotion('promo-X');
      q.optInManualPromotion('promo-X');
      expect(q.optedInManualPromotionIds).toEqual(['promo-X']);
      expect(q.vetoedPromotionIds).toEqual([]);
    });

    it('addVetoedPromotion cross-clears the opt-in set (veto wins)', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.optInManualPromotion('promo-X');
      q.addVetoedPromotion('promo-X');
      expect(q.optedInManualPromotionIds).toEqual([]);
      expect(q.vetoedPromotionIds).toEqual(['promo-X']);
    });

    it('optOutManualPromotion removes the id from the opted-in set', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.optInManualPromotion('promo-M');
      q.optOutManualPromotion('promo-M');
      expect(q.optedInManualPromotionIds).toEqual([]);
    });
  });

  describe('lifecycle — expiry + lazy status (T004)', () => {
    it('setExpiry updates the expiry date on DRAFT', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      const expiry = new Date('2026-12-31T00:00:00Z');
      q.setExpiry(expiry);
      expect(q.expiresAt).toEqual(expiry);
    });

    it('setExpiry(null) clears the expiry', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.setExpiry(new Date('2026-12-31T00:00:00Z'));
      q.setExpiry(null);
      expect(q.expiresAt).toBeNull();
    });

    it('setExpiry throws on non-DRAFT quotation', () => {
      const q = Quotation.fromPersistence({
        id: 'q-sent',
        sellerUserId: SELLER,
        customerId: null,
        globalPriceListId: null,
        priceListExplicitlySet: false,
        status: 'SENT',
        expiresAt: null,
        cancelReason: null,
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        manuallyEnded: false,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(() => q.setExpiry(new Date())).toThrow(BusinessRuleViolationError);
    });

    it('getEffectiveStatus returns DRAFT when no expiry is set', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      const now = new Date('2026-07-15T12:00:00Z');
      expect(q.getEffectiveStatus(now)).toBe('DRAFT');
    });

    it('getEffectiveStatus returns SENT when status is SENT and expiry is null', () => {
      const q = Quotation.fromPersistence({
        id: 'q-sent',
        sellerUserId: SELLER,
        customerId: null,
        globalPriceListId: null,
        priceListExplicitlySet: false,
        status: 'SENT',
        expiresAt: null,
        cancelReason: null,
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        manuallyEnded: false,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(q.getEffectiveStatus(new Date('2026-07-15T12:00:00Z'))).toBe('SENT');
    });

    it('getEffectiveStatus flips to EXPIRED when expiry is in the past', () => {
      const q = Quotation.fromPersistence({
        id: 'q-sent',
        sellerUserId: SELLER,
        customerId: null,
        globalPriceListId: null,
        priceListExplicitlySet: false,
        status: 'SENT',
        expiresAt: new Date('2026-01-01T00:00:00Z'),
        cancelReason: null,
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        manuallyEnded: false,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const now = new Date('2026-07-15T12:00:00Z');
      expect(q.getEffectiveStatus(now)).toBe('EXPIRED');
    });

    it('getEffectiveStatus preserves CANCELLED even if expiry has passed', () => {
      const q = Quotation.fromPersistence({
        id: 'q-cancelled',
        sellerUserId: SELLER,
        customerId: null,
        globalPriceListId: null,
        priceListExplicitlySet: false,
        status: 'CANCELLED',
        expiresAt: new Date('2026-01-01T00:00:00Z'),
        cancelReason: 'OTHER',
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        manuallyEnded: false,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(q.getEffectiveStatus(new Date('2026-07-15T12:00:00Z'))).toBe(
        'CANCELLED',
      );
    });

    it('getEffectiveStatus defaults to current time when no `now` is provided', () => {
      const q = Quotation.fromPersistence({
        id: 'q-far-future',
        sellerUserId: SELLER,
        customerId: null,
        globalPriceListId: null,
        priceListExplicitlySet: false,
        status: 'SENT',
        expiresAt: new Date('2099-12-31T00:00:00Z'),
        cancelReason: null,
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        manuallyEnded: false,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      // No `now` argument — far-future expiry means status stays SENT
      expect(q.getEffectiveStatus()).toBe('SENT');
    });
  });

  describe('recomputeTotals', () => {
    it('returns subtotal=0 / discount=0 / total=0 on an empty draft', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      const totals = q.recomputeTotals();
      expect(totals).toEqual({
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
      });
    });

    it('returns subtotal = Σ (unitPrice × qty), discount = Σ discountAmountCents, total = subtotal - discount', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addItem(validItemProps('item-1', { quantity: 2, unitPriceCents: 5000 }));
      q.addItem(validItemProps('item-2', {
        productId: 'prod-002',
        quantity: 3,
        unitPriceCents: 1000,
      }));

      const totals = q.recomputeTotals();
      expect(totals.subtotalCents).toBe(2 * 5000 + 3 * 1000); // 13000
      expect(totals.discountCents).toBe(0);
      expect(totals.totalCents).toBe(13000);
    });

    it('is idempotent — running twice yields the same totals', () => {
      const q = Quotation.create({ id: newQuotationId(), sellerUserId: SELLER });
      q.addItem(validItemProps('item-1', { quantity: 2, unitPriceCents: 5000 }));

      const a = q.recomputeTotals();
      const b = q.recomputeTotals();
      expect(a).toEqual(b);
    });
  });

  describe('toResponse', () => {
    it('returns the wire shape with status + items + totals', () => {
      const q = Quotation.create({
        id: 'q-1',
        sellerUserId: SELLER,
        customerId: 'cust-1',
        globalPriceListId: 'pl-1',
      });
      q.addItem(validItemProps('item-1', { quantity: 1, unitPriceCents: 5000 }));

      const response = q.toResponse();
      expect(response).toMatchObject({
        id: 'q-1',
        sellerUserId: SELLER,
        status: 'DRAFT',
        customerId: 'cust-1',
        globalPriceListId: 'pl-1',
        priceListExplicitlySet: false,
        subtotalCents: 5000,
        discountCents: 0,
        totalCents: 5000,
      });
      expect(response.items).toHaveLength(1);
      expect(response.expiresAt).toBeNull();
      expect(response.cancelReason).toBeNull();
    });
  });
});
