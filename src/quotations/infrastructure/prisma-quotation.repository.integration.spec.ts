/**
 * PrismaQuotationRepository — Integration Tests (RED phase → GREEN with real DB)
 *
 * Covers T005: PrismaQuotationRepository round-trip + isolation.
 *
 * Skips gracefully when the test DB is unreachable (`SKIP_DB_INTEGRATION=1`
 * or no `DATABASE_URL`). Runs against the dedicated `nest-practice-test`
 * database — never the dev DB.
 *
 * Uses the `resetAndSeedBaseline` helper to wipe state between tests so a
 * mid-test failure cannot leak rows into the next spec.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
} from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PrismaQuotationRepository } from './prisma-quotation.repository';
import { Quotation } from '../domain/quotation.entity';
import { QuotationItem } from '../domain/quotation-item.entity';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb('PrismaQuotationRepository (Integration - Real DB)', () => {
  let prisma: PrismaClient;
  let repo: PrismaQuotationRepository;
  let tenantId: string;
  let userId: string;

  const newQuotationId = () => randomUUID();
  const newItemId = () => randomUUID();

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    // One-time reset + tenant seed so the CLS shim has a tenant to bind to.
    await resetAndSeedBaseline();

    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) {
      throw new Error(
        'No tenant found for integration test. globalSetup must have seeded one.',
      );
    }
    tenantId = tenant.id;

    // The repository's `findById` requires a tenantId in CLS — wire up a
    // minimal CLS shim that returns the baseline tenant for every request.
    const cls: Pick<ClsService<TenantClsStore>, 'get'> = {
      get: (key: string) => {
        if (key === 'tenantId') return tenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    };

    const tenantPrisma = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls as ClsService<TenantClsStore>,
    );
    repo = new PrismaQuotationRepository(tenantPrisma);
  });

  // `afterEach` resets the DB — including the user and any products — so
  // the per-test setup re-creates fresh dependencies on every test. The
  // `quotations_sellerUserId_fkey` and `quotation_items_productId_fkey`
  // FKs are Restrict, so a stale id would 500.
  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `quotation-seller-${randomUUID()}@test.local`,
        hashedPassword: 'test',
        name: 'Quotation Seller',
        isActive: true,
      },
      select: { id: true },
    });
    userId = user.id;

    // Create a product so quotation_items_productId_fkey can resolve.
    // `tenantId` rides along via the TENANT_SCOPED_MODELS auto-injection
    // (the CLS shim above returns the baseline tenant for every request).
    await prisma.product.create({
      data: {
        id: 'prod-test-001',
        name: 'Test Product',
        tenantId: tenantId,
        chargeProductTaxes: true,
        ivaRate: 'IVA_16',
        iepsRate: 'NO_APLICA',
        purchaseCostMode: 'NET',
        purchaseNetCostCents: 0,
        purchaseGrossCostCents: 0,
        useStock: false,
        sellInPos: true,
        includeInOnlineCatalog: true,
        hasVariants: false,
        hidePriceInOnlineCatalog: false,
      },
    });
  });

  afterEach(async () => {
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await disconnectIntegrationPrisma();
  });

  describe('save + findById round-trip', () => {
    it('persists an empty DRAFT quotation and reads it back', async () => {
      const id = newQuotationId();
      const draft = Quotation.create({
        id,
        sellerUserId: userId,
      });

      const saved = await repo.save(draft);

      expect(saved.id).toBe(id);
      expect(saved.status).toBe('DRAFT');
      expect(saved.customerId).toBeNull();
      expect(saved.globalPriceListId).toBeNull();
      expect(saved.items).toEqual([]);
      expect(saved.subtotalCents).toBe(0);
      expect(saved.totalCents).toBe(0);

      const fetched = await repo.findById(id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(id);
      expect(fetched?.sellerUserId).toBe(userId);
      expect(fetched?.status).toBe('DRAFT');
    });

    it('persists a quotation with items and round-trips them', async () => {
      const id = newQuotationId();
      const q = Quotation.create({ id, sellerUserId: userId });
      q.addItem({
        id: newItemId(),
        quotationId: id,
        productId: 'prod-test-001',
        variantId: null,
        productName: 'Persisted Product',
        variantName: null,
        quantity: 3,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
        priceSource: 'PRICE_LIST',
      });

      await repo.save(q);

      const fetched = await repo.findById(id);
      expect(fetched).not.toBeNull();
      expect(fetched?.items).toHaveLength(1);
      expect(fetched?.items[0]?.productId).toBe('prod-test-001');
      expect(fetched?.items[0]?.quantity).toBe(3);
      expect(fetched?.items[0]?.unitPriceCents).toBe(2000);
      expect(fetched?.items[0]?.priceSource).toBe('PRICE_LIST');
    });

    it('updates an existing quotation on a second save (upsert behaviour)', async () => {
      const id = newQuotationId();
      const draft = Quotation.create({ id, sellerUserId: userId });
      await repo.save(draft);

      const cancelled = draft.cancel(
        'CUSTOMER_REQUEST',
        new Date('2026-07-15T10:00:00Z'),
      );
      await repo.save(cancelled);

      const fetched = await repo.findById(id);
      expect(fetched?.status).toBe('CANCELLED');
      expect(fetched?.cancelReason).toBe('CUSTOMER_REQUEST');
    });

    it('returns null for a non-existent quotation id', async () => {
      const fetched = await repo.findById('00000000-0000-0000-0000-000000000099');
      expect(fetched).toBeNull();
    });
  });

  describe('findAll — pagination + tenant scoping', () => {
    it('returns paginated quotations scoped to the current tenant', async () => {
      // Seed 3 quotations for the baseline tenant
      for (let i = 0; i < 3; i++) {
        await repo.save(
          Quotation.create({ id: newQuotationId(), sellerUserId: userId }),
        );
      }

      const result = await repo.findAll({ page: 1, limit: 10 });
      expect(result.total).toBe(3);
      expect(result.data).toHaveLength(3);
      result.data.forEach((q) => {
        expect(q.sellerUserId).toBe(userId);
      });
    });

    it('applies pagination (limit) correctly', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.save(
          Quotation.create({ id: newQuotationId(), sellerUserId: userId }),
        );
      }

      const first = await repo.findAll({ page: 1, limit: 2 });
      expect(first.total).toBe(5);
      expect(first.data).toHaveLength(2);

      const second = await repo.findAll({ page: 2, limit: 2 });
      expect(second.data).toHaveLength(2);

      const third = await repo.findAll({ page: 3, limit: 2 });
      expect(third.data).toHaveLength(1);
    });

    it('returns an empty result when no quotations exist', async () => {
      const result = await repo.findAll({ page: 1, limit: 10 });
      expect(result.total).toBe(0);
      expect(result.data).toEqual([]);
    });
  });

  describe('cross-tenant isolation', () => {
    it('does NOT leak quotations belonging to a different tenant', async () => {
      const ownId = newQuotationId();
      await repo.save(
        Quotation.create({ id: ownId, sellerUserId: userId }),
      );

      // Create a second tenant with its own user + quotation
      const otherTenantId = randomUUID();
      await prisma.tenant.create({
        data: {
          id: otherTenantId,
          name: 'Other Tenant',
          slug: `other-${randomUUID().slice(0, 8)}`,
          isActive: true,
        },
      });
      const otherUserId = randomUUID();
      await prisma.user.create({
        data: {
          id: otherUserId,
          email: `other-seller-${randomUUID()}@test.local`,
          hashedPassword: 'test',
          name: 'Other Seller',
          isActive: true,
        },
      });

      const otherQuotationId = newQuotationId();
      await prisma.quotation.create({
        data: {
          id: otherQuotationId,
          sellerUserId: otherUserId,
          tenantId: otherTenantId,
          status: 'DRAFT',
          subtotalCents: 0,
          discountCents: 0,
          totalCents: 0,
        },
      });

      // From the baseline tenant's CLS context, findById must NOT return the
      // other tenant's quotation (cross-tenant access returns null)
      const fetched = await repo.findById(otherQuotationId);
      expect(fetched).toBeNull();

      // findAll must NOT include the other tenant's quotation
      const list = await repo.findAll({ page: 1, limit: 100 });
      expect(list.data.map((q) => q.id)).not.toContain(otherQuotationId);
      expect(list.data.map((q) => q.id)).toContain(ownId);
    });
  });

  describe('delete', () => {
    it('removes a quotation from the database', async () => {
      const id = newQuotationId();
      await repo.save(
        Quotation.create({ id, sellerUserId: userId }),
      );

      const fetched = await repo.findById(id);
      expect(fetched).not.toBeNull();

      await repo.delete(id);

      const afterDelete = await repo.findById(id);
      expect(afterDelete).toBeNull();
    });

    it('is a no-op when the quotation does not exist', async () => {
      // Should NOT throw — Prisma's `delete` raises P2025, but the repo
      // absorbs that for idempotent caller flows. Adjust expectation if the
      // repo explicitly throws (either contract is acceptable).
      await expect(
        repo.delete('00000000-0000-0000-0000-000000000099'),
      ).resolves.toBeUndefined();
    });
  });
});
