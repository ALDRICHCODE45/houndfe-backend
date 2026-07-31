/**
 * QuotationsService — Application Layer Tests (RED phase)
 *
 * Covers T012–T017 (WU2 — service core + draft CRUD + customer +
 * price-list mutation + lazy EXPIRED on read + cross-tenant 404).
 *
 * The service depends on:
 *   - IQuotationRepository (port — mocked here)
 *   - TenantPrismaService (for catalog lookups: customer.globalPriceListId,
 *     globalPriceList existence check — mocked via getClient())
 *
 * `recomputePricingAndPromotions` is intentionally a no-op stub in WU2
 * (full wiring lands in WU3 once items/promotions/expiry + the engine
 * context branch are in). The recompute is invoked on every draft
 * mutation today, but it does not yet mutate totals.
 */
import { randomUUID } from 'node:crypto';
import { QuotationsService } from './quotations.service';
import { Quotation } from '../domain/quotation.entity';
import { QuotationNotFoundError } from '../domain/quotation.errors';
import type { IQuotationRepository, QuotationFindAllQuery } from '../domain/quotation.repository';
import {
  EntityNotFoundError,
  BusinessRuleViolationError,
} from '../../shared/domain/domain-error';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

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
    getClient: jest.fn(() => client as never),
    getTenantId: jest.fn(() => tenantId),
  }) as never;

const buildService = (
  repo: jest.Mocked<IQuotationRepository>,
  tenantPrisma: ReturnType<typeof makeTenantPrisma>,
) => new QuotationsService(repo, tenantPrisma as never);

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
});
