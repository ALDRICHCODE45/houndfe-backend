/**
 * INTEGRATION SPEC: PrismaPublicCatalogRepository — F1.WU5e1
 * real-DB tenant and catalog-default gate evidence.
 *
 * Proves against the `nest-practice-test` DB (port 5433 — NEVER dev):
 *   1. `findActiveBranches()` (the F1.WU5e1 published-branches gate)
 *      returns ONLY tenants that are simultaneously active AND
 *      `catalogPublished`; active+unpublished and inactive+published
 *      tenants are excluded. Assertions filter to tracked fixture IDs
 *      so the result never depends on baseline/pre-existing rows.
 *   2. `findTenantCatalogDefaultPriceListId()` is tenant-context
 *      scoped via the mutable CLS shim: each tenant resolves only its
 *      own exact `isCatalogDefault=true` global price-list ID, a
 *      tenant without a default gets null, and no cross-tenant
 *      leakage occurs.
 *   3. Repeated reads return identical values and do not change the
 *      tracked table row counts (pure reads).
 *
 * Mirrors the fixture conventions of
 * `prisma-catalog-settings.repository.integration.spec.ts`:
 * randomized UUIDs/slugs/names per run, one shared PrismaClient, a
 * mutable typed CLS shim, explicit FK-safe cleanup (NO TRUNCATE),
 * reset current tenant between tests, disconnect at the end.
 *
 * Unit coverage remains authoritative for `PublicTenantGuard`; this
 * slice intentionally does not duplicate it (WU5e1 scope).
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
} from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PrismaPublicCatalogRepository } from './prisma-public-catalog.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

const tenantSlug = (id: string): string => `pc-int-${id.slice(0, 8)}`;

describeIfDb('PrismaPublicCatalogRepository (Integration - Real DB)', () => {
  let prisma: PrismaClient;
  let repo: PrismaPublicCatalogRepository;
  /** Mutable CLS tenant — cross-tenant tests switch this. */
  let currentTenantId: string;
  const baselineTenantId = BASELINE_TENANT_ID;

  // Per-test tracked ids for explicit-delete cleanup (no TRUNCATE).
  const trackedTenantIds: string[] = [];
  const trackedGlobalPriceListIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    // Bounded test-shim CLS — cast through `unknown` (structural
    // `Pick<ClsService<S>, 'get'>` produced TS2322 in the sibling spec).
    const cls = {
      get: (key: string) => {
        if (key === 'tenantId') return currentTenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    } as unknown as ClsService<TenantClsStore>;
    const tenantPrisma = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls,
    );
    repo = new PrismaPublicCatalogRepository(
      prisma as unknown as ConstructorParameters<
        typeof PrismaPublicCatalogRepository
      >[0],
      tenantPrisma,
    );
  });

  beforeEach(() => {
    currentTenantId = baselineTenantId;
    trackedTenantIds.length = 0;
    trackedGlobalPriceListIds.length = 0;
  });

  afterEach(async () => {
    currentTenantId = baselineTenantId;
    try {
      if (trackedTenantIds.length > 0) {
        await prisma.tenantCatalogPriceList.deleteMany({
          where: { tenantId: { in: trackedTenantIds } },
        });
        await prisma.tenant.deleteMany({
          where: { id: { in: trackedTenantIds } },
        });
      }
      if (trackedGlobalPriceListIds.length > 0) {
        await prisma.globalPriceList.deleteMany({
          where: { id: { in: trackedGlobalPriceListIds } },
        });
      }
    } finally {
      trackedTenantIds.length = 0;
      trackedGlobalPriceListIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await disconnectIntegrationPrisma();
  });

  // ── Fixture helpers ────────────────────────────────────────────────────
  async function seedTenant(
    label: string,
    opts: { isActive: boolean; catalogPublished: boolean },
  ): Promise<{ id: string; name: string }> {
    const id = randomUUID();
    const name = `PC INT Tenant ${label} ${id.slice(0, 8)}`;
    await prisma.tenant.create({
      data: {
        id,
        name,
        slug: tenantSlug(id),
        isActive: opts.isActive,
        catalogPublished: opts.catalogPublished,
      },
    });
    trackedTenantIds.push(id);
    return { id, name };
  }

  async function seedGlobalPriceList(suffix: string): Promise<string> {
    const id = randomUUID();
    await prisma.globalPriceList.create({
      data: {
        id,
        name: `pc-int-list-${id.slice(0, 8)}-${suffix}`,
        isDefault: false,
      },
    });
    trackedGlobalPriceListIds.push(id);
    return id;
  }

  async function seedBinding(input: {
    tenantId: string;
    globalPriceListId: string;
    isCatalogDefault: boolean;
  }): Promise<void> {
    await prisma.tenantCatalogPriceList.create({
      data: {
        tenantId: input.tenantId,
        globalPriceListId: input.globalPriceListId,
        isCatalogDefault: input.isCatalogDefault,
      },
    });
  }

  // ── Tests ──────────────────────────────────────────────────────────────

  describe('findActiveBranches — published-branches gate (T1)', () => {
    it('returns only active+catalogPublished tenants; excludes active+unpublished and inactive+published', async () => {
      const publishedA = await seedTenant('A', {
        isActive: true,
        catalogPublished: true,
      });
      const publishedB = await seedTenant('B', {
        isActive: true,
        catalogPublished: true,
      });
      const activeUnpublished = await seedTenant('C', {
        isActive: true,
        catalogPublished: false,
      });
      const inactivePublished = await seedTenant('D', {
        isActive: false,
        catalogPublished: true,
      });

      const branches = await repo.findActiveBranches();

      // Filter to tracked fixtures — no dependence on baseline rows.
      const trackedBranches = branches.filter((b) =>
        trackedTenantIds.includes(b.id),
      );

      // Exact expected subset: only the two active+published tenants,
      // in the repository's name-ascending order.
      const expectedIds = [publishedA, publishedB]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => t.id);
      expect(trackedBranches.map((b) => b.id)).toEqual(expectedIds);

      // Both exclusion quadrants are absent from the full result.
      const allResultIds = branches.map((b) => b.id);
      expect(allResultIds).not.toContain(activeUnpublished.id);
      expect(allResultIds).not.toContain(inactivePublished.id);

      // Projected fields round-trip from the real rows.
      for (const branch of trackedBranches) {
        const seeded = [publishedA, publishedB].find((t) => t.id === branch.id);
        expect(seeded).toBeDefined();
        expect(branch.name).toBe(seeded!.name);
        expect(branch.slug).toBe(tenantSlug(branch.id));
      }
    });

    it('repeated findActiveBranches returns identical results and does not change tenant row counts', async () => {
      await seedTenant('A', { isActive: true, catalogPublished: true });
      await seedTenant('B', { isActive: true, catalogPublished: false });

      const beforeCount = await prisma.tenant.count({
        where: { id: { in: trackedTenantIds } },
      });

      const first = await repo.findActiveBranches();
      const second = await repo.findActiveBranches();

      const afterCount = await prisma.tenant.count({
        where: { id: { in: trackedTenantIds } },
      });

      expect(afterCount).toBe(beforeCount);
      expect(beforeCount).toBe(2);
      const firstTracked = first.filter((b) => trackedTenantIds.includes(b.id));
      const secondTracked = second.filter((b) =>
        trackedTenantIds.includes(b.id),
      );
      expect(secondTracked).toEqual(firstTracked);
    });
  });

  describe('findTenantCatalogDefaultPriceListId — tenant-scoped via CLS (T2)', () => {
    it('resolves each tenant\u2019s own exact isCatalogDefault global list; no-default tenant gets null; no cross-tenant leakage', async () => {
      const tenantA = await seedTenant('A', {
        isActive: true,
        catalogPublished: true,
      });
      const tenantB = await seedTenant('B', {
        isActive: true,
        catalogPublished: true,
      });
      const tenantC = await seedTenant('C', {
        isActive: true,
        catalogPublished: true,
      });

      const gA1 = await seedGlobalPriceList('a-default');
      const gA2 = await seedGlobalPriceList('a-extra');
      const gB = await seedGlobalPriceList('b-default');

      await seedBinding({
        tenantId: tenantA.id,
        globalPriceListId: gA1,
        isCatalogDefault: true,
      });
      await seedBinding({
        tenantId: tenantA.id,
        globalPriceListId: gA2,
        isCatalogDefault: false,
      });
      await seedBinding({
        tenantId: tenantB.id,
        globalPriceListId: gB,
        isCatalogDefault: true,
      });

      currentTenantId = tenantA.id;
      const aDefault = await repo.findTenantCatalogDefaultPriceListId();
      expect(aDefault).toBe(gA1);
      expect(aDefault).not.toBe(gA2); // non-default binding ignored
      expect(aDefault).not.toBe(gB); // B's list never leaks into A

      currentTenantId = tenantB.id;
      const bDefault = await repo.findTenantCatalogDefaultPriceListId();
      expect(bDefault).toBe(gB);
      expect(bDefault).not.toBe(gA1); // A's list never leaks into B

      currentTenantId = tenantC.id;
      const cDefault = await repo.findTenantCatalogDefaultPriceListId();
      expect(cDefault).toBeNull(); // fail-closed: no binding → null
    });

    it('repeated findTenantCatalogDefaultPriceListId returns identical values and does not change binding row counts', async () => {
      const tenantA = await seedTenant('A', {
        isActive: true,
        catalogPublished: true,
      });
      const gA1 = await seedGlobalPriceList('a-default');
      await seedBinding({
        tenantId: tenantA.id,
        globalPriceListId: gA1,
        isCatalogDefault: true,
      });

      currentTenantId = tenantA.id;

      const beforeBindings = await prisma.tenantCatalogPriceList.count({
        where: { tenantId: tenantA.id },
      });

      const first = await repo.findTenantCatalogDefaultPriceListId();
      const second = await repo.findTenantCatalogDefaultPriceListId();

      const afterBindings = await prisma.tenantCatalogPriceList.count({
        where: { tenantId: tenantA.id },
      });

      expect(afterBindings).toBe(beforeBindings);
      expect(beforeBindings).toBe(1);
      expect(first).toBe(gA1);
      expect(second).toBe(first);
    });
  });
});
