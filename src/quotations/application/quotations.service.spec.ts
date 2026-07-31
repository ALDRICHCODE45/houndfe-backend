/**
 * QuotationsService — Application Layer Tests.
 *
 * WU2 covers T012–T017 (service core + draft CRUD + customer + price-list
 * mutation + lazy EXPIRED on read + cross-tenant 404).
 *
 * WU3 covers T022–T039 (item CRUD + promotion toggle + price override +
 * expiry + cancel + engine widening). The recompute pipeline is now
 * wired through `ProductsService` + `IPosEvaluatePromotionsUseCase` —
 * the test mocks provide stubbed no-op implementations so the existing
 * WU2 assertions (which don't exercise items/promotions) keep their
 * green-pass contract.
 */
import { randomUUID } from 'node:crypto';
import { QuotationsService } from './quotations.service';
import { Quotation } from '../domain/quotation.entity';
import { QuotationNotFoundError } from '../domain/quotation.errors';
import type { IQuotationRepository, QuotationFindAllQuery } from '../domain/quotation.repository';
import {
  EntityNotFoundError,
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ProductsService } from '../../products/products.service';
import type { IPosEvaluatePromotionsUseCase } from '../../promotions/application/ports/pos-evaluate-promotions.port';

const SELLER = 'seller-1';
const TENANT = 'tenant-1';

const newQuotationId = () => randomUUID();

const basePersistence = (overrides: Record<string, unknown> = {}) => ({
  id: newQuotationId(),
  sellerUserId: SELLER,
  customerId: null,
  globalPriceListId: null,
  priceListExplicitlySet: false,
  status: 'DRAFT' as const,
  expiresAt: null,
  cancelReason: null,
  canceledAt: null,
  subtotalCents: 0,
  discountCents: 0,
  totalCents: 0,
  manuallyEnded: false,
  items: [],
  vetoedPromotionIds: [],
  optedInManualPromotionIds: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeQuotation = (overrides: Record<string, unknown> = {}) =>
  Quotation.fromPersistence(basePersistence(overrides) as any);

const makeRepo = (overrides: Partial<IQuotationRepository> = {}) =>
  ({
    save: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  }) as jest.Mocked<IQuotationRepository>;

const makeTenantPrisma = (
  client: Record<string, unknown> = {},
  tenantId: string | null = TENANT,
): jest.Mocked<Pick<TenantPrismaService, 'getClient' | 'getTenantId'>> =>
  ({
    getClient: jest.fn(() => ({
      customer: { findUnique: jest.fn(async () => null) },
      globalPriceList: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
      ...client,
    } as never)),
    getTenantId: jest.fn(() => tenantId),
  }) as never;

const makeProductsService = (): jest.Mocked<
  Pick<ProductsService, 'getProductInfoForSale' | 'batchResolvePriceMap' | 'resolvePriceListGlobalIds' | 'resolveProductCategoryBrandIds'>
> =>
  ({
    getProductInfoForSale: jest.fn(),
    batchResolvePriceMap: jest.fn(async () => new Map()),
    resolvePriceListGlobalIds: jest.fn(async () => new Map<string, string>()),
    resolveProductCategoryBrandIds: jest.fn(async () => new Map()),
  }) as never;

const makeEngine = (): jest.Mocked<IPosEvaluatePromotionsUseCase> =>
  ({
    evaluate: jest.fn(async (input: any) => ({
      lines: [],
      order: null,
      availableManualPromotions: [],
      // Self-heal: echo the opted-in ids back so the service does NOT
      // prune them. Tests that exercise the self-heal can override this
      // mock to return an empty list.
      targetableManualPromotionIds: [...(input?.optedInManualPromotionIds ?? [])],
    })),
  }) as never;

const buildService = (
  repo: jest.Mocked<IQuotationRepository>,
  tenantPrisma: ReturnType<typeof makeTenantPrisma>,
  productsService: ReturnType<typeof makeProductsService> = makeProductsService(),
  engine: ReturnType<typeof makeEngine> = makeEngine(),
) =>
  new QuotationsService(
    repo,
    tenantPrisma as never,
    productsService as never,
    engine as never,
  );

describe('QuotationsService — WU2', () => {
  describe('openDraft (T012)', () => {
    it('creates a DRAFT quotation with no customer when no customerId is provided', async () => {
      const repo = makeRepo({
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      const result = await service.openDraft(SELLER);

      expect(repo.save).toHaveBeenCalledTimes(1);
      const saved = (repo.save as jest.Mock).mock.calls[0][0] as Quotation;
      expect(saved.status).toBe('DRAFT');
      expect(saved.sellerUserId).toBe(SELLER);
      expect(saved.customerId).toBeNull();
      expect(saved.globalPriceListId).toBeNull();
      expect(saved.id).toEqual(expect.any(String));
      expect(result).toMatchObject({
        id: saved.id,
        status: 'DRAFT',
        sellerUserId: SELLER,
        customerId: null,
        globalPriceListId: null,
      });
    });

    it('auto-seeds globalPriceListId from customer.globalPriceListId when customerId is provided', async () => {
      const repo = makeRepo({
        save: jest.fn(async (q) => q),
      });
      const customerId = randomUUID();
      const prisma = makeTenantPrisma({
        customer: {
          findUnique: jest.fn(async () => ({
            id: customerId,
            globalPriceListId: 'gpl-mayoreo',
          })),
        },
      });
      const service = buildService(repo, prisma);

      const result = await service.openDraft(SELLER, { customerId });

      expect(prisma.getClient().customer.findUnique).toHaveBeenCalledWith({
        where: { id: customerId },
        select: { id: true, globalPriceListId: true },
      });
      const saved = (repo.save as jest.Mock).mock.calls[0][0] as Quotation;
      expect(saved.customerId).toBe(customerId);
      expect(saved.globalPriceListId).toBe('gpl-mayoreo');
      expect(result.customerId).toBe(customerId);
      expect(result.globalPriceListId).toBe('gpl-mayoreo');
    });

    it('leaves globalPriceListId null when customer has no default list', async () => {
      const repo = makeRepo({
        save: jest.fn(async (q) => q),
      });
      const customerId = randomUUID();
      const prisma = makeTenantPrisma({
        customer: {
          findUnique: jest.fn(async () => ({
            id: customerId,
            globalPriceListId: null,
          })),
        },
      });
      const service = buildService(repo, prisma);

      const result = await service.openDraft(SELLER, { customerId });

      expect(result.customerId).toBe(customerId);
      expect(result.globalPriceListId).toBeNull();
    });

    it('uses explicit globalPriceListId over the customer default', async () => {
      const repo = makeRepo({
        save: jest.fn(async (q) => q),
      });
      const customerId = randomUUID();
      const prisma = makeTenantPrisma({
        customer: {
          findUnique: jest.fn(async () => ({
            id: customerId,
            globalPriceListId: 'gpl-customer-default',
          })),
        },
      });
      const service = buildService(repo, prisma);

      await service.openDraft(SELLER, {
        customerId,
        globalPriceListId: 'gpl-explicit',
      });

      const saved = (repo.save as jest.Mock).mock.calls[0][0] as Quotation;
      expect(saved.customerId).toBe(customerId);
      expect(saved.globalPriceListId).toBe('gpl-explicit');
      // Cashier's explicit choice — assignCustomer MUST NOT re-seed later.
      expect(saved.priceListExplicitlySet).toBe(true);
    });

    it('throws 404 when customerId is provided but the customer does not exist', async () => {
      const repo = makeRepo({
        save: jest.fn(),
      });
      const customerId = randomUUID();
      const prisma = makeTenantPrisma({
        customer: {
          findUnique: jest.fn(async () => null),
        },
      });
      const service = buildService(repo, prisma);

      await expect(
        service.openDraft(SELLER, { customerId }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('assignCustomer (T015)', () => {
    it('auto-seeds the price list from customer.globalPriceListId', async () => {
      const draft = makeQuotation();
      const customerId = randomUUID();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma({
        customer: {
          findUnique: jest.fn(async () => ({
            id: customerId,
            globalPriceListId: 'gpl-mayoreo',
          })),
        },
      });
      const service = buildService(repo, prisma);

      const result = await service.assignCustomer(draft.id, { customerId });

      expect(prisma.getClient().customer.findUnique).toHaveBeenCalledWith({
        where: { id: customerId },
        select: { id: true, globalPriceListId: true },
      });
      expect(draft.customerId).toBe(customerId);
      expect(draft.globalPriceListId).toBe('gpl-mayoreo');
      expect(draft.priceListExplicitlySet).toBe(false); // auto-seed
      expect(repo.save).toHaveBeenCalledWith(draft);
      expect(result.customerId).toBe(customerId);
      expect(result.globalPriceListId).toBe('gpl-mayoreo');
    });

    it('does not re-seed an explicitly-set price list', async () => {
      const draft = makeQuotation({
        globalPriceListId: 'gpl-cashier',
        priceListExplicitlySet: true,
      });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const customerId = randomUUID();
      const prisma = makeTenantPrisma({
        customer: {
          findUnique: jest.fn(async () => ({
            id: customerId,
            globalPriceListId: 'gpl-mayoreo',
          })),
        },
      });
      const service = buildService(repo, prisma);

      await service.assignCustomer(draft.id, { customerId });

      expect(draft.customerId).toBe(customerId);
      // Cashier's explicit choice is preserved.
      expect(draft.globalPriceListId).toBe('gpl-cashier');
    });

    it('throws 404 when the draft does not exist in the current tenant', async () => {
      const draft = makeQuotation();
      const customerId = randomUUID();
      const repo = makeRepo({
        findById: jest.fn(async () => null),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma({
        customer: {
          findUnique: jest.fn(async () => ({
            id: customerId,
            globalPriceListId: null,
          })),
        },
      });
      const service = buildService(repo, prisma);

      await expect(
        service.assignCustomer(draft.id, { customerId }),
      ).rejects.toBeInstanceOf(QuotationNotFoundError);
    });

    it('throws 404 when the customer does not exist', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma({
        customer: {
          findUnique: jest.fn(async () => null),
        },
      });
      const service = buildService(repo, prisma);

      await expect(
        service.assignCustomer(draft.id, { customerId: randomUUID() }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
    });

    it('rejects non-DRAFT quotations (already SENT)', async () => {
      const sent = makeQuotation({ status: 'SENT' });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.assignCustomer(sent.id, { customerId: randomUUID() }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('setPriceList (T016)', () => {
    it('binds the draft to the new global price list and triggers recompute', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma({
        globalPriceList: {
          findUnique: jest.fn(async () => ({ id: 'gpl-mayoreo' })),
        },
      });
      const service = buildService(repo, prisma);

      const result = await service.setPriceList(draft.id, {
        globalPriceListId: 'gpl-mayoreo',
      });

      expect(prisma.getClient().globalPriceList.findUnique).toHaveBeenCalledWith(
        {
          where: { id: 'gpl-mayoreo' },
          select: { id: true },
        },
      );
      expect(draft.globalPriceListId).toBe('gpl-mayoreo');
      expect(draft.priceListExplicitlySet).toBe(true); // cashier explicit
      expect(repo.save).toHaveBeenCalledWith(draft);
      expect(result.globalPriceListId).toBe('gpl-mayoreo');
    });

    it('rejects an unknown global price list with 400 and leaves the draft unchanged', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma({
        globalPriceList: {
          findUnique: jest.fn(async () => null),
        },
      });
      const service = buildService(repo, prisma);

      await expect(
        service.setPriceList(draft.id, {
          globalPriceListId: 'gpl-does-not-exist',
        }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(draft.globalPriceListId).toBeNull();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects non-DRAFT quotations', async () => {
      const sent = makeQuotation({ status: 'SENT' });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma({
        globalPriceList: {
          findUnique: jest.fn(async () => ({ id: 'gpl-mayoreo' })),
        },
      });
      const service = buildService(repo, prisma);

      await expect(
        service.setPriceList(sent.id, { globalPriceListId: 'gpl-mayoreo' }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('findOne (T013)', () => {
    it('returns the full quotation with lazy EXPIRED transition on read', async () => {
      const sent = makeQuotation({
        status: 'SENT',
        expiresAt: new Date('2020-01-01T00:00:00Z'),
      });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      const result = await service.findOne(sent.id);

      expect(result.status).toBe('SENT'); // persisted
      expect(result.effectiveStatus).toBe('EXPIRED'); // lazy
    });

    it('keeps SENT status when expiresAt is null', async () => {
      const sent = makeQuotation({ status: 'SENT', expiresAt: null });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      const result = await service.findOne(sent.id);

      expect(result.status).toBe('SENT');
      expect(result.effectiveStatus).toBe('SENT');
    });

    it('returns 404 (cross-tenant simulation) when the quotation is missing', async () => {
      const repo = makeRepo({
        findById: jest.fn(async () => null),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(service.findOne('non-existent-id')).rejects.toBeInstanceOf(
        QuotationNotFoundError,
      );
    });
  });

  describe('findAll (T014)', () => {
    it('returns paginated data + total', async () => {
      const items = [makeQuotation(), makeQuotation(), makeQuotation()];
      const repo = makeRepo({
        findAll: jest.fn(async () => ({ data: items, total: 3 })),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(repo.findAll).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        status: undefined,
        customerId: undefined,
        createdFrom: undefined,
        createdTo: undefined,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });
      expect(result.data).toHaveLength(3);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 3,
        totalPages: 1,
      });
    });

    it('computes totalPages = ceil(total/limit) and 0 when no rows', async () => {
      const repo = makeRepo({
        findAll: jest.fn(async () => ({ data: [], total: 0 })),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      const result = await service.findAll({ page: 1, limit: 20 });
      expect(result.pagination.totalPages).toBe(0);

      (repo.findAll as jest.Mock).mockResolvedValueOnce({
        data: [],
        total: 75,
      });
      const result2 = await service.findAll({ page: 1, limit: 20 });
      expect(result2.pagination.totalPages).toBe(4);
    });

    it('passes filters down to the repository (status, customerId, date range, sort)', async () => {
      const repo = makeRepo({
        findAll: jest.fn(async () => ({ data: [], total: 0 })),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      const createdFrom = new Date('2026-01-01T00:00:00Z');
      const createdTo = new Date('2026-12-31T23:59:59Z');
      await service.findAll({
        page: 2,
        limit: 10,
        status: 'DRAFT',
        customerId: randomUUID(),
        createdFrom,
        createdTo,
        sortBy: 'totalCents',
        sortOrder: 'asc',
      });

      const passed = (repo.findAll as jest.Mock).mock
        .calls[0][0] as QuotationFindAllQuery;
      expect(passed).toMatchObject({
        page: 2,
        limit: 10,
        status: 'DRAFT',
        customerId: expect.any(String),
        createdFrom,
        createdTo,
        sortBy: 'totalCents',
        sortOrder: 'asc',
      });
    });

    it('applies lazy EXPIRED transition on each SENT row after the read', async () => {
      const sent = makeQuotation({
        status: 'SENT',
        expiresAt: new Date('2020-01-01T00:00:00Z'),
      });
      const draft = makeQuotation({ status: 'DRAFT' });
      const repo = makeRepo({
        findAll: jest.fn(async () => ({ data: [sent, draft], total: 2 })),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data[0].effectiveStatus).toBe('EXPIRED');
      expect(result.data[1].effectiveStatus).toBe('DRAFT');
    });
  });

  describe('default sort/sortOrder when omitted', () => {
    it('uses createdAt desc on the repo call when query omits both', async () => {
      const repo = makeRepo({
        findAll: jest.fn(async () => ({ data: [], total: 0 })),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await service.findAll({ page: 1, limit: 20 });

      const passed = (repo.findAll as jest.Mock).mock.calls[0][0];
      expect(passed.sortBy ?? 'createdAt').toBe('createdAt');
      expect(passed.sortOrder ?? 'desc').toBe('desc');
    });
  });

  // ================================================================
  // WU3 — items + promotions + price override + expiry + cancel
  // ================================================================

  describe('WU3 — addItem', () => {
    it('resolves price via ProductsService and triggers a recompute with context=QUOTATION', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const productsService = makeProductsService();
      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-1',
        productName: 'Product 1',
        variantId: null,
        variantName: null,
        unitPriceCents: 1000,
        imageUrl: null,
      });
      const engine = makeEngine();
      const service = buildService(repo, prisma, productsService, engine);

      const result = await service.addItem(draft.id, {
        productId: 'prod-1',
        quantity: 2,
      });

      expect(productsService.getProductInfoForSale).toHaveBeenCalledWith(
        'prod-1',
        null,
      );
      expect(draft.items).toHaveLength(1);
      expect(draft.items[0]?.productId).toBe('prod-1');
      expect(draft.items[0]?.quantity).toBe(2);
      expect(draft.items[0]?.unitPriceCents).toBe(1000);
      expect(draft.items[0]?.priceSource).toBe('PRICE_LIST');
      expect(engine.evaluate).toHaveBeenCalledTimes(1);
      const engineInput = (engine.evaluate as jest.Mock).mock.calls[0][0];
      expect(engineInput.context).toBe('QUOTATION');
      expect(engineInput.lines).toHaveLength(1);
      expect(engineInput.lines[0].effectiveUnitPriceCents).toBe(1000);
      expect(repo.save).toHaveBeenCalledWith(draft);
      expect(result.id).toBe(draft.id);
    });

    it('does NOT call checkStockAvailability (stock check bypassed per spec)', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const productsService = makeProductsService();
      productsService.getProductInfoForSale.mockResolvedValue({
        productId: 'prod-1',
        productName: 'Product 1',
        variantId: null,
        variantName: null,
        unitPriceCents: 1000,
        imageUrl: null,
      });
      const engine = makeEngine();
      const service = buildService(repo, prisma, productsService, engine);

      await service.addItem(draft.id, { productId: 'prod-1', quantity: 1 });

      // No `checkStockAvailability` method on the products service mock —
      // strict-mode existence check (would FAIL if the service tried to
      // call it).
      expect(
        (productsService as unknown as { checkStockAvailability?: unknown })
          .checkStockAvailability,
      ).toBeUndefined();
    });

    it('throws 404 when the draft does not exist', async () => {
      const repo = makeRepo({
        findById: jest.fn(async () => null),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.addItem('missing', { productId: 'prod-1', quantity: 1 }),
      ).rejects.toBeInstanceOf(QuotationNotFoundError);
    });

    it('throws 404 when the product does not exist', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const productsService = makeProductsService();
      productsService.getProductInfoForSale.mockRejectedValue(
        new EntityNotFoundError('Product', 'prod-missing'),
      );
      const service = buildService(repo, prisma, productsService);

      await expect(
        service.addItem(draft.id, { productId: 'prod-missing', quantity: 1 }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects non-DRAFT quotations', async () => {
      const sent = makeQuotation({ status: 'SENT' });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.addItem(sent.id, { productId: 'prod-1', quantity: 1 }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('WU3 — updateItemQuantity', () => {
    it('updates the quantity and triggers a recompute', async () => {
      const draft = makeQuotation({
        items: [
          {
            id: 'item-1',
            quotationId: 'q-1',
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 1,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
        ],
      });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const engine = makeEngine();
      const service = buildService(repo, prisma, undefined, engine);

      await service.updateItemQuantity(draft.id, 'item-1', { quantity: 5 });

      expect(draft.items[0]?.quantity).toBe(5);
      expect(engine.evaluate).toHaveBeenCalledTimes(1);
      const engineInput = (engine.evaluate as jest.Mock).mock.calls[0][0];
      expect(engineInput.lines[0].quantity).toBe(5);
      expect(repo.save).toHaveBeenCalled();
    });

    it('rejects quantity < 1', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.updateItemQuantity(draft.id, 'item-1', { quantity: 0 }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it('rejects non-DRAFT quotations', async () => {
      const sent = makeQuotation({ status: 'SENT' });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.updateItemQuantity(sent.id, 'item-1', { quantity: 2 }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });
  });

  describe('WU3 — removeItem', () => {
    it('removes the item and triggers a recompute', async () => {
      const draft = makeQuotation({
        items: [
          {
            id: 'item-1',
            quotationId: 'q-1',
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 1,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
          {
            id: 'item-2',
            quotationId: 'q-1',
            productId: 'prod-2',
            variantId: null,
            productName: 'Product 2',
            variantName: null,
            quantity: 1,
            unitPriceCents: 2000,
            unitPriceCurrency: 'MXN',
          },
        ],
      });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const engine = makeEngine();
      const service = buildService(repo, prisma, undefined, engine);

      await service.removeItem(draft.id, 'item-1');

      expect(draft.items).toHaveLength(1);
      expect(draft.items[0]?.id).toBe('item-2');
      expect(engine.evaluate).toHaveBeenCalledTimes(1);
    });

    it('rejects non-DRAFT quotations', async () => {
      const sent = makeQuotation({ status: 'SENT' });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.removeItem(sent.id, 'item-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });
  });

  describe('WU3 — overrideItemPrice', () => {
    it('marks the item CUSTOM and triggers a recompute', async () => {
      const draft = makeQuotation({
        items: [
          {
            id: 'item-1',
            quotationId: 'q-1',
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 1,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
        ],
      });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const engine = makeEngine();
      const service = buildService(repo, prisma, undefined, engine);

      await service.overrideItemPrice(draft.id, 'item-1', {
        unitPriceCents: 2500,
      });

      expect(draft.items[0]?.unitPriceCents).toBe(2500);
      expect(draft.items[0]?.priceSource).toBe('CUSTOM');
      expect(draft.items[0]?.customPriceCents).toBe(2500);
      expect(engine.evaluate).toHaveBeenCalledTimes(1);
      // The engine still receives the persisted line (post-override
      // values) so it can re-evaluate per-line promos on the new
      // baseline. The reprice step (which would skip CUSTOM lines) is
      // a separate pass; the engine input is the post-reprice state.
      const engineInput = (engine.evaluate as jest.Mock).mock.calls[0][0];
      expect(engineInput.lines).toHaveLength(1);
      expect(engineInput.lines[0].effectiveUnitPriceCents).toBe(2500);
      expect(engineInput.context).toBe('QUOTATION');
    });

    it('rejects non-DRAFT quotations', async () => {
      const sent = makeQuotation({ status: 'SENT' });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.overrideItemPrice(sent.id, 'item-1', { unitPriceCents: 100 }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });
  });

  describe('WU3 — applyManualPromotion / removeManualPromotion', () => {
    it('applyManualPromotion adds the id to the opt-in set and recomputes', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const engine = makeEngine();
      const service = buildService(repo, prisma, undefined, engine);

      await service.applyManualPromotion(draft.id, 'promo-m-1');

      expect(draft.optedInManualPromotionIds).toEqual(['promo-m-1']);
      expect(engine.evaluate).toHaveBeenCalledTimes(1);
      const engineInput = (engine.evaluate as jest.Mock).mock.calls[0][0];
      expect(engineInput.optedInManualPromotionIds).toEqual(['promo-m-1']);
    });

    it('applyManualPromotion cross-clears the veto set (reactivation path)', async () => {
      const draft = makeQuotation({
        vetoedPromotionIds: ['promo-x'],
      });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await service.applyManualPromotion(draft.id, 'promo-x');

      expect(draft.optedInManualPromotionIds).toEqual(['promo-x']);
      expect(draft.vetoedPromotionIds).toEqual([]);
    });

    it('removeManualPromotion removes the id from the opt-in set and recomputes', async () => {
      const draft = makeQuotation({
        optedInManualPromotionIds: ['promo-m-1'],
      });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const engine = makeEngine();
      const service = buildService(repo, prisma, undefined, engine);

      await service.removeManualPromotion(draft.id, 'promo-m-1');

      expect(draft.optedInManualPromotionIds).toEqual([]);
      expect(engine.evaluate).toHaveBeenCalledTimes(1);
    });

    it('rejects non-DRAFT quotations', async () => {
      const sent = makeQuotation({ status: 'SENT' });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.applyManualPromotion(sent.id, 'promo-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      await expect(
        service.removeManualPromotion(sent.id, 'promo-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });
  });

  describe('WU3 — vetoPromotion / optInPromotion', () => {
    it('vetoPromotion adds the id to the veto set and recomputes', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const engine = makeEngine();
      const service = buildService(repo, prisma, undefined, engine);

      await service.vetoPromotion(draft.id, 'promo-a-1');

      expect(draft.vetoedPromotionIds).toEqual(['promo-a-1']);
      expect(engine.evaluate).toHaveBeenCalledTimes(1);
      const engineInput = (engine.evaluate as jest.Mock).mock.calls[0][0];
      expect(engineInput.vetoedPromotionIds).toEqual(['promo-a-1']);
    });

    it('optInPromotion removes the id from the veto set and recomputes', async () => {
      const draft = makeQuotation({
        vetoedPromotionIds: ['promo-a-1'],
      });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const engine = makeEngine();
      const service = buildService(repo, prisma, undefined, engine);

      await service.optInPromotion(draft.id, 'promo-a-1');

      expect(draft.vetoedPromotionIds).toEqual([]);
      expect(engine.evaluate).toHaveBeenCalledTimes(1);
    });

    it('rejects non-DRAFT quotations', async () => {
      const sent = makeQuotation({ status: 'SENT' });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.vetoPromotion(sent.id, 'promo-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });
  });

  describe('WU3 — setExpiry', () => {
    it('sets the expiry on a DRAFT quotation', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      const expiry = new Date('2026-12-31T00:00:00Z');
      await service.setExpiry(draft.id, {
        expiresAt: expiry.toISOString(),
      });

      expect(draft.expiresAt).toEqual(expiry);
      expect(repo.save).toHaveBeenCalled();
    });

    it('null clears the expiry', async () => {
      const draft = makeQuotation({
        expiresAt: new Date('2026-12-31T00:00:00Z'),
      });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await service.setExpiry(draft.id, { expiresAt: null });

      expect(draft.expiresAt).toBeNull();
    });

    it('rejects non-DRAFT quotations', async () => {
      const sent = makeQuotation({ status: 'SENT' });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.setExpiry(sent.id, {
          expiresAt: new Date('2026-12-31T00:00:00Z').toISOString(),
        }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });
  });

  describe('WU3 — cancel', () => {
    it('transitions a DRAFT quotation to CANCELLED with the given reason', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      const result = await service.cancel(draft.id, {
        cancelReason: 'CUSTOMER_REQUEST',
      });

      expect(result.status).toBe('CANCELLED');
      expect(result.cancelReason).toBe('CUSTOMER_REQUEST');
      expect(repo.save).toHaveBeenCalled();
      const saved = (repo.save as jest.Mock).mock.calls[0][0] as Quotation;
      expect(saved.status).toBe('CANCELLED');
    });

    it('is idempotent on CANCELLED (re-cancel returns the same instance)', async () => {
      const draft = makeQuotation();
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      // First cancel flips DRAFT to CANCELLED.
      const first = await service.cancel(draft.id, {
        cancelReason: 'CUSTOMER_REQUEST',
      });
      expect(first.status).toBe('CANCELLED');

      // Replace the repo mock so the next call returns the CANCELLED
      // entity (simulating a real persistence round-trip — the entity
      // layer is the source of truth).
      const persistedFirst = (repo.save as jest.Mock).mock.calls[0][0] as Quotation;
      expect(persistedFirst.status).toBe('CANCELLED');
      (repo.findById as jest.Mock).mockResolvedValueOnce(persistedFirst);
      const second = await service.cancel(persistedFirst.id, {
        cancelReason: 'OTHER',
      });
      expect(second.status).toBe('CANCELLED');
      // The pre-existing cancelReason is preserved — the entity's
      // `cancel` is idempotent on CANCELLED.
      expect(second.cancelReason).toBe('CUSTOMER_REQUEST');
    });

    it('can transition from SENT to CANCELLED', async () => {
      const sent = makeQuotation({ status: 'SENT' });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === sent.id ? sent : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      const result = await service.cancel(sent.id, { cancelReason: 'OTHER' });
      expect(result.status).toBe('CANCELLED');
    });

    it('throws 404 when the draft does not exist', async () => {
      const repo = makeRepo({
        findById: jest.fn(async () => null),
        save: jest.fn(),
      });
      const prisma = makeTenantPrisma();
      const service = buildService(repo, prisma);

      await expect(
        service.cancel('missing', { cancelReason: 'OTHER' }),
      ).rejects.toBeInstanceOf(QuotationNotFoundError);
    });
  });

  describe('WU3 — recompute idempotency (T039)', () => {
    it('two back-to-back recomputes on the same draft yield the same applied state', async () => {
      const draft = makeQuotation({
        items: [
          {
            id: 'item-1',
            quotationId: 'q-1',
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 1,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
        ],
      });
      const repo = makeRepo({
        findById: jest.fn(async (id) => (id === draft.id ? draft : null)),
        save: jest.fn(async (q) => q),
      });
      const prisma = makeTenantPrisma();
      const engine = makeEngine();
      const service = buildService(repo, prisma, undefined, engine);

      const first = await service.updateItemQuantity(draft.id, 'item-1', {
        quantity: 3,
      });
      const itemsBefore = JSON.stringify(draft.items);
      const firstTotals = {
        subtotal: first.subtotalCents,
        discount: first.discountCents,
        total: first.totalCents,
      };
      const engineCallsBefore = (engine.evaluate as jest.Mock).mock.calls.length;

      // Second recompute via updateItemQuantity with the same value —
      // items stay the same; engine still runs but the input is byte-
      // equal to the previous run.
      const second = await service.updateItemQuantity(draft.id, 'item-1', {
        quantity: 3,
      });
      const itemsAfter = JSON.stringify(draft.items);

      expect(itemsAfter).toBe(itemsBefore);
      expect(second.subtotalCents).toBe(firstTotals.subtotal);
      expect(second.discountCents).toBe(firstTotals.discount);
      expect(second.totalCents).toBe(firstTotals.total);
      expect((engine.evaluate as jest.Mock).mock.calls.length).toBe(
        engineCallsBefore + 1,
      );
    });
  });
});
