/**
 * SalesService — Application Layer Tests
 *
 * Tests for POS sales use cases: openDraft, addItem, updateItemQuantity,
 * clearItems, deleteDraft, getUserDrafts.
 */
import { SalesService } from './sales.service';
import type { ISaleRepository } from './domain/sale.repository';
import { Sale } from './domain/sale.entity';
import {
  EntityNotFoundError,
  BusinessRuleViolationError,
} from '../shared/domain/domain-error';
import type { ProductsService } from '../products/products.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';

// ── Minimal mocks ──────────────────────────────────────────────────────

function makeMockSaleRepo(overrides: Partial<ISaleRepository> = {}) {
  return {
    save: jest.fn(),
    findById: jest.fn(),
    findDraftsByUserId: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as jest.Mocked<ISaleRepository>;
}

function makeMockProductsService() {
  return {
    getProductInfoForSale: jest.fn(),
    checkStockAvailability: jest.fn(),
    getApplicablePrices: jest.fn(),
    resolveListPrice: jest.fn(),
  } as any;
}

function makeMockEventEmitter() {
  return {
    emit: jest.fn(),
  } as any;
}

function createService(
  saleRepo: ISaleRepository,
  productsService: ProductsService,
  eventEmitter: EventEmitter2,
) {
  return new SalesService(saleRepo, productsService, eventEmitter);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SalesService', () => {
  let saleRepo: ReturnType<typeof makeMockSaleRepo>;
  let productsService: ReturnType<typeof makeMockProductsService>;
  let eventEmitter: ReturnType<typeof makeMockEventEmitter>;
  let service: SalesService;

  beforeEach(() => {
    saleRepo = makeMockSaleRepo();
    productsService = makeMockProductsService();
    eventEmitter = makeMockEventEmitter();
    service = createService(saleRepo, productsService, eventEmitter);
  });

  describe('item discount use-cases', () => {
    it('applies item discount and emits event', async () => {
      const sale = Sale.create({ id: 'sale-discount', userId: 'user-1' });
      sale.addItem({
        id: 'item-1', saleId: 'sale-discount', productId: 'prod-1', variantId: null,
        productName: 'Prod', variantName: null, quantity: 1, unitPriceCents: 1000, unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.applyItemDiscount('sale-discount', 'item-1', {
        type: 'percentage',
        percent: 15,
        discountTitle: 'promo',
      }, 'user-1');

      expect(result.items[0].discountType).toBe('percentage');
      expect(result.items[0].discountTitle).toBe('promo');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.discount.applied',
        expect.objectContaining({ saleId: 'sale-discount', itemId: 'item-1' }),
      );
    });

    it('removes item discount and emits event', async () => {
      const sale = Sale.create({ id: 'sale-discount-2', userId: 'user-1' });
      sale.addItem({
        id: 'item-1', saleId: 'sale-discount-2', productId: 'prod-1', variantId: null,
        productName: 'Prod', variantName: null, quantity: 1, unitPriceCents: 1000, unitPriceCurrency: 'MXN',
      });
      sale.applyItemDiscount('item-1', { type: 'amount', amountCents: 100 });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.removeItemDiscount('sale-discount-2', 'item-1', 'user-1');
      expect(result.items[0].discountType).toBeNull();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.discount.removed',
        expect.objectContaining({ saleId: 'sale-discount-2', itemId: 'item-1' }),
      );
    });
  });

  describe('openDraft', () => {
    it('should create a new draft sale and emit event', async () => {
      const userId = 'user-1';

      const result = await service.openDraft(userId);

      expect(result).toMatchObject({
        userId,
        status: 'DRAFT',
        items: [],
      });
      expect(result.id).toBeDefined();
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.draft.opened',
        expect.objectContaining({
          saleId: result.id,
          userId,
        }),
      );
    });
  });

  describe('addItem', () => {
    it('should add item to draft with price snapshot and emit event', async () => {
      const saleId = 'sale-1';
      const sale = Sale.create({ id: saleId, userId: 'user-1' });

      saleRepo.findById.mockResolvedValue(sale);
      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-1',
        productName: 'Aspirina',
        variantId: null,
        variantName: null,
        unitPriceCents: 5000,
      });
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 100,
      });

      const result = await service.addItem(saleId, 'user-1', {
        productId: 'prod-1',
        variantId: null,
        quantity: 2,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        productId: 'prod-1',
        productName: 'Aspirina',
        variantId: null,
        quantity: 2,
        unitPriceCents: 5000,
      });
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.added',
        expect.objectContaining({
          saleId,
          productId: 'prod-1',
          quantity: 2,
        }),
      );
    });

    it('should reject when sale does not exist', async () => {
      saleRepo.findById.mockResolvedValue(null);

      await expect(
        service.addItem('nonexistent', 'user-1', {
          productId: 'prod-1',
          variantId: null,
          quantity: 1,
        }),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('should reject when user does not own the sale', async () => {
      const sale = Sale.create({ id: 'sale-2', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.addItem('sale-2', 'user-2', {
          productId: 'prod-1',
          variantId: null,
          quantity: 1,
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
      await expect(
        service.addItem('sale-2', 'user-2', {
          productId: 'prod-1',
          variantId: null,
          quantity: 1,
        }),
      ).rejects.toThrow(/not own this sale/);
    });

    it('should reject when stock is insufficient', async () => {
      const sale = Sale.create({ id: 'sale-3', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-2',
        productName: 'Limited Item',
        variantId: null,
        variantName: null,
        unitPriceCents: 10000,
      });

      productsService.checkStockAvailability.mockResolvedValue({
        available: false,
        currentStock: 3,
      });

      await expect(
        service.addItem('sale-3', 'user-1', {
          productId: 'prod-2',
          variantId: null,
          quantity: 10,
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
      await expect(
        service.addItem('sale-3', 'user-1', {
          productId: 'prod-2',
          variantId: null,
          quantity: 10,
        }),
      ).rejects.toThrow(/Insufficient stock/);
    });

    it('should validate cumulative stock when stacking same product+variant', async () => {
      // RED test: verify stock check uses cumulative quantity when item already exists
      const sale = Sale.create({ id: 'sale-cumulative', userId: 'user-1' });

      // Pre-add an item with quantity 3
      sale.addItem({
        id: 'item-existing',
        saleId: 'sale-cumulative',
        productId: 'prod-limited',
        variantId: null,
        productName: 'Limited Stock Product',
        variantName: null,
        quantity: 3,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);

      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-limited',
        productName: 'Limited Stock Product',
        variantId: null,
        variantName: null,
        unitPriceCents: 5000,
      });

      // Stock is 5, existing quantity is 3, incoming is 3, cumulative would be 6 → should fail
      productsService.checkStockAvailability.mockResolvedValue({
        available: false,
        currentStock: 5,
      });

      await expect(
        service.addItem('sale-cumulative', 'user-1', {
          productId: 'prod-limited',
          variantId: null,
          quantity: 3,
        }),
      ).rejects.toThrow(/Insufficient stock/);

      // Verify checkStockAvailability was called with cumulative quantity 6 (3 existing + 3 incoming)
      expect(productsService.checkStockAvailability).toHaveBeenCalledWith(
        'prod-limited',
        null,
        6, // cumulative quantity
      );
    });

    it('should allow stacking when cumulative stock is sufficient', async () => {
      // TRIANGULATE: verify successful stacking when cumulative quantity fits stock
      const sale = Sale.create({ id: 'sale-stack-ok', userId: 'user-1' });

      // Pre-add an item with quantity 2
      sale.addItem({
        id: 'item-existing-ok',
        saleId: 'sale-stack-ok',
        productId: 'prod-ok',
        variantId: null,
        productName: 'Sufficient Stock Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);

      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-ok',
        productName: 'Sufficient Stock Product',
        variantId: null,
        variantName: null,
        unitPriceCents: 5000,
      });

      // Stock is 10, existing is 2, incoming is 3, cumulative is 5 → should succeed
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 10,
      });

      const result = await service.addItem('sale-stack-ok', 'user-1', {
        productId: 'prod-ok',
        variantId: null,
        quantity: 3,
      });

      // Should have 1 item with stacked quantity 5
      expect(result.items).toHaveLength(1);
      expect(result.items[0].quantity).toBe(5);

      // Verify checkStockAvailability was called with cumulative quantity 5
      expect(productsService.checkStockAvailability).toHaveBeenCalledWith(
        'prod-ok',
        null,
        5,
      );
    });

    it('should not check cumulative stock for different product+variant combinations', async () => {
      // TRIANGULATE: verify non-stacking items use only incoming quantity
      const sale = Sale.create({ id: 'sale-different', userId: 'user-1' });

      // Pre-add a variant "Red"
      sale.addItem({
        id: 'item-red',
        saleId: 'sale-different',
        productId: 'prod-x',
        variantId: 'var-red',
        productName: 'Product X',
        variantName: 'Red',
        quantity: 5,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);

      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-x',
        productName: 'Product X',
        variantId: 'var-blue',
        variantName: 'Blue',
        unitPriceCents: 5000,
      });

      // Adding variant "Blue" should NOT include "Red" quantity in stock check
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 10,
      });

      await service.addItem('sale-different', 'user-1', {
        productId: 'prod-x',
        variantId: 'var-blue',
        quantity: 3,
      });

      // Should check only incoming quantity 3, not cumulative
      expect(productsService.checkStockAvailability).toHaveBeenCalledWith(
        'prod-x',
        'var-blue',
        3, // NOT 8 (5 + 3)
      );
    });
  });

  describe('updateItemQuantity', () => {
    it('should update item quantity and emit event', async () => {
      const sale = Sale.create({ id: 'sale-4', userId: 'user-1' });
      sale.addItem({
        id: 'item-1',
        saleId: 'sale-4',
        productId: 'prod-1',
        variantId: null,
        productName: 'Item',
        variantName: null,
        quantity: 5,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);
      productsService.checkStockAvailability.mockResolvedValue({
        available: true,
        currentStock: 100,
      });

      const result = await service.updateItemQuantity(
        'sale-4',
        'user-1',
        'item-1',
        { quantity: 10 },
      );

      expect(result.items[0].quantity).toBe(10);
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.quantity.changed',
        expect.objectContaining({
          saleId: 'sale-4',
          itemId: 'item-1',
          previousQuantity: 5,
          newQuantity: 10,
        }),
      );
    });

    it('should reject when sale does not exist', async () => {
      saleRepo.findById.mockResolvedValue(null);

      await expect(
        service.updateItemQuantity('nonexistent', 'user-1', 'item-1', {
          quantity: 5,
        }),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('should reject when user does not own the sale', async () => {
      const sale = Sale.create({ id: 'sale-5', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.updateItemQuantity('sale-5', 'user-2', 'item-1', {
          quantity: 5,
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });

    it('should reject when insufficient stock for new quantity', async () => {
      const sale = Sale.create({ id: 'sale-6', userId: 'user-1' });
      sale.addItem({
        id: 'item-2',
        saleId: 'sale-6',
        productId: 'prod-3',
        variantId: null,
        productName: 'Limited',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);
      productsService.checkStockAvailability.mockResolvedValue({
        available: false,
        currentStock: 5,
      });

      await expect(
        service.updateItemQuantity('sale-6', 'user-1', 'item-2', {
          quantity: 10,
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });
  });

  describe('clearItems', () => {
    it('should clear all items and emit event', async () => {
      const sale = Sale.create({ id: 'sale-7', userId: 'user-1' });
      sale.addItem({
        id: 'item-3',
        saleId: 'sale-7',
        productId: 'prod-1',
        variantId: null,
        productName: 'Item 1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-4',
        saleId: 'sale-7',
        productId: 'prod-2',
        variantId: null,
        productName: 'Item 2',
        variantName: null,
        quantity: 2,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.clearItems('sale-7', 'user-1');

      expect(result.items).toHaveLength(0);
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.cleared',
        expect.objectContaining({
          saleId: 'sale-7',
          clearedItemCount: 2,
        }),
      );
    });

    it('should be idempotent when already empty', async () => {
      const sale = Sale.create({ id: 'sale-8', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.clearItems('sale-8', 'user-1');

      expect(result.items).toHaveLength(0);
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.cleared',
        expect.objectContaining({
          clearedItemCount: 0,
        }),
      );
    });
  });

  describe('removeItem', () => {
    it('should remove item, persist, emit event, and return updated sale response', async () => {
      const sale = Sale.create({ id: 'sale-remove-1', userId: 'user-1' });
      sale.addItem({
        id: 'item-keep',
        saleId: 'sale-remove-1',
        productId: 'prod-1',
        variantId: null,
        productName: 'Keep',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-remove',
        saleId: 'sale-remove-1',
        productId: 'prod-2',
        variantId: null,
        productName: 'Remove',
        variantName: null,
        quantity: 2,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);

      const result = await service.removeItem(
        'sale-remove-1',
        'user-1',
        'item-remove',
      );

      expect(result.id).toBe('sale-remove-1');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('item-keep');
      expect(saleRepo.save).toHaveBeenCalledWith(expect.any(Sale));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.removed',
        expect.objectContaining({
          saleId: 'sale-remove-1',
          itemId: 'item-remove',
          actorId: 'user-1',
        }),
      );
    });

    it('should throw SALE_NOT_FOUND when sale does not exist', async () => {
      saleRepo.findById.mockResolvedValue(null);

      await expect(
        service.removeItem('sale-remove-404', 'user-1', 'item-remove'),
      ).rejects.toThrow(
        new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND'),
      );
    });

    it('should throw SALE_NOT_DRAFT when sale status is not DRAFT', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-remove-not-draft',
        userId: 'user-1',
        status: 'COMPLETED' as any,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.removeItem('sale-remove-not-draft', 'user-1', 'item-remove'),
      ).rejects.toThrow(
        new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT'),
      );
    });

    it('should throw SALE_UPDATE_FORBIDDEN when actor is not owner', async () => {
      const sale = Sale.create({ id: 'sale-remove-forbidden', userId: 'owner-1' });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.removeItem('sale-remove-forbidden', 'user-2', 'item-remove'),
      ).rejects.toThrow(
        new BusinessRuleViolationError(
          'SALE_UPDATE_FORBIDDEN',
          'SALE_UPDATE_FORBIDDEN',
        ),
      );
    });

    it('should throw SALE_ITEM_NOT_FOUND when item is not in sale', async () => {
      const sale = Sale.create({ id: 'sale-remove-no-item', userId: 'user-1' });
      sale.addItem({
        id: 'item-existing',
        saleId: 'sale-remove-no-item',
        productId: 'prod-1',
        variantId: null,
        productName: 'Existing',
        variantName: null,
        quantity: 1,
        unitPriceCents: 500,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(
        service.removeItem('sale-remove-no-item', 'user-1', 'item-missing'),
      ).rejects.toThrow(
        new BusinessRuleViolationError(
          'SALE_ITEM_NOT_FOUND',
          'SALE_ITEM_NOT_FOUND',
        ),
      );
    });
  });

  describe('deleteDraft', () => {
    it('should delete draft and emit event', async () => {
      const sale = Sale.create({ id: 'sale-9', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      await service.deleteDraft('sale-9', 'user-1');

      expect(saleRepo.delete).toHaveBeenCalledWith('sale-9');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.draft.deleted',
        expect.objectContaining({
          saleId: 'sale-9',
          userId: 'user-1',
        }),
      );
    });

    it('should reject when sale does not exist', async () => {
      saleRepo.findById.mockResolvedValue(null);

      await expect(
        service.deleteDraft('nonexistent', 'user-1'),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('should reject when user does not own the sale', async () => {
      const sale = Sale.create({ id: 'sale-10', userId: 'user-1' });
      saleRepo.findById.mockResolvedValue(sale);

      await expect(service.deleteDraft('sale-10', 'user-2')).rejects.toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('getUserDrafts', () => {
    it('should return all drafts for a user', async () => {
      const drafts = [
        Sale.create({ id: 'sale-11', userId: 'user-1' }),
        Sale.create({ id: 'sale-12', userId: 'user-1' }),
      ];

      saleRepo.findDraftsByUserId.mockResolvedValue(drafts);

      const result = await service.getUserDrafts('user-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sale-11');
      expect(result[1].id).toBe('sale-12');
    });

    it('should return empty array when no drafts exist', async () => {
      saleRepo.findDraftsByUserId.mockResolvedValue([]);

      const result = await service.getUserDrafts('user-2');

      expect(result).toHaveLength(0);
    });

    // S15: Create Unlimited Drafts per User
    it('should allow a user to create 6+ drafts in sequence (unlimited)', async () => {
      const userId = 'user-unlimited';
      const createdDraftIds: string[] = [];

      // Simulate creating 6 drafts in sequence
      for (let i = 1; i <= 6; i++) {
        const draft = await service.openDraft(userId);
        createdDraftIds.push(draft.id);
        expect(draft.userId).toBe(userId);
        expect(draft.status).toBe('DRAFT');
      }

      // Mock getUserDrafts to return all 6 created drafts
      const allDraftsFromRepo = createdDraftIds.map((id) =>
        Sale.create({ id, userId }),
      );
      saleRepo.findDraftsByUserId.mockResolvedValue(allDraftsFromRepo);

      const allDrafts = await service.getUserDrafts(userId);

      // ASSERT: All 6 drafts were created and persisted
      expect(allDrafts).toHaveLength(6);
      expect(allDrafts.every((d) => d.userId === userId)).toBe(true);
      expect(allDrafts.every((d) => d.status === 'DRAFT')).toBe(true);

      // Verify no draft limit was enforced (service never rejected)
      expect(saleRepo.save).toHaveBeenCalledTimes(6);
    });
  });

  describe('searchPosCatalog', () => {
    it('should delegate to ProductsService.searchForPOS', async () => {
      // Arrange
      const mockCatalogResponse = {
        items: [
          {
            id: 'prod-1',
            name: 'Aspirina',
            sku: 'ASP-500',
            barcode: '7501234567890',
            unit: 'PIEZA',
            hasVariants: false,
            useStock: true,
            category: { id: 'cat-1', name: 'Medicamentos' },
            brand: { id: 'brand-1', name: 'Bayer' },
            mainImage: 'https://example.com/asp.jpg',
            images: ['https://example.com/asp.jpg'],
            price: {
              priceCents: 5000,
              priceDecimal: 50,
              priceListName: 'PUBLICO',
            },
            stock: { quantity: 120, minQuantity: 10 },
            variants: [],
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      };

      productsService.searchForPOS = jest
        .fn()
        .mockResolvedValue(mockCatalogResponse);

      const dto = { q: 'Aspirina', limit: 25, offset: 0 };

      // Act
      const result = await service.searchPosCatalog(dto);

      // Assert
      expect(result).toEqual(mockCatalogResponse);
      expect(productsService.searchForPOS).toHaveBeenCalledWith(dto);
    });
  });

  describe('price override use cases', () => {
    it('getAvailablePrices should return mapped prices with isCurrent', async () => {
      const sale = Sale.create({ id: 'sale-av', userId: 'user-1' });
      sale.addItem({
        id: 'item-av',
        saleId: 'sale-av',
        productId: 'prod-1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);
      productsService.getApplicablePrices.mockResolvedValue([
        { priceListId: 'pl-1', priceListName: 'PUBLICO', priceCents: 1000 },
      ]);

      const result = await service.getAvailablePrices(
        'sale-av',
        'item-av',
        'user-1',
      );
      expect(result.prices[0].isCurrent).toBe(true);
    });

    it('getAvailablePrices should match current by appliedPriceListId first', async () => {
      const sale = Sale.create({ id: 'sale-av2', userId: 'user-1' });
      sale.addItem({
        id: 'item-av2',
        saleId: 'sale-av2',
        productId: 'prod-1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.overrideItemPrice('item-av2', {
        priceCents: 950,
        priceSource: 'price_list',
        appliedPriceListId: 'pl-2',
        customPriceCents: null,
      });

      saleRepo.findById.mockResolvedValue(sale);
      productsService.getApplicablePrices.mockResolvedValue([
        { priceListId: 'pl-1', priceListName: 'PUBLICO', priceCents: 950 },
        { priceListId: 'pl-2', priceListName: 'MAYOREO', priceCents: 950 },
      ]);

      const result = await service.getAvailablePrices(
        'sale-av2',
        'item-av2',
        'user-1',
      );
      expect(
        result.prices.find((p) => p.priceListId === 'pl-1')?.isCurrent,
      ).toBe(false);
      expect(
        result.prices.find((p) => p.priceListId === 'pl-2')?.isCurrent,
      ).toBe(true);
    });

    it('getAvailablePrices should fallback to unitPrice match when appliedPriceListId is null', async () => {
      const sale = Sale.create({ id: 'sale-av3', userId: 'user-1' });
      sale.addItem({
        id: 'item-av3',
        saleId: 'sale-av3',
        productId: 'prod-1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      saleRepo.findById.mockResolvedValue(sale);
      productsService.getApplicablePrices.mockResolvedValue([
        { priceListId: 'pl-1', priceListName: 'PUBLICO', priceCents: 1000 },
        { priceListId: 'pl-2', priceListName: 'MAYOREO', priceCents: 900 },
      ]);

      const result = await service.getAvailablePrices(
        'sale-av3',
        'item-av3',
        'user-1',
      );
      expect(
        result.prices.find((p) => p.priceListId === 'pl-1')?.isCurrent,
      ).toBe(true);
      expect(
        result.prices.find((p) => p.priceListId === 'pl-2')?.isCurrent,
      ).toBe(false);
    });

    it('overrideItemPrice should emit one audit event', async () => {
      const sale = Sale.create({ id: 'sale-ov', userId: 'user-1' });
      sale.addItem({
        id: 'item-ov',
        saleId: 'sale-ov',
        productId: 'prod-1',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      saleRepo.findById.mockResolvedValue(sale);
      saleRepo.save.mockResolvedValue(sale);
      productsService.resolveListPrice.mockResolvedValue(900);

      await service.overrideItemPrice(
        'sale-ov',
        'item-ov',
        { priceListId: 'pl-1' },
        'user-1',
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sale.item.price.overridden',
        expect.any(Object),
      );
    });
  });
});
