/**
 * INTEGRATION SPEC: PrismaCatalogSettingsRepository — F1.WU2b.1d
 * real PostgreSQL read/isolation evidence.
 *
 * Proves against the `nest-practice-test` DB (port 5433 — NEVER dev):
 *   1. Tenant A reads its own settings + bindings, reconstructs names
 *      and the default selection from the joined GlobalPriceList row.
 *   2. Tenant B's read does NOT expose Tenant A's bindings/settings.
 *   3. Repeated `findByTenantId` returns identical aggregates and
 *      creates zero rows in any underlying table.
 *   4. `findGlobalPriceListsByIds` returns the requested existing
 *      subset and silently drops non-existent ids.
 *   5. `countDefaultContextCoverage` scopes by tenant AND list AND
 *      `priceCents > 0`.
 *
 * Mirrors `prisma-delivery-route.repository.integration.spec.ts`
 * (shared PrismaClient, mutable CLS shim, baseline-aware integrationPrisma).
 * Fixtures are randomized per test (randomUUID + derived unique
 * slugs/names) so reruns cannot collide with stale rows.
 *
 * Cleanup (NO TRUNCATE): explicit-delete by tracked id arrays.
 *   1. Tenant-owned rows first (TenantCatalogPriceList →
 *      ProductCatalogPriceList → PriceList → Product → Tenant).
 *   2. Randomized GlobalPriceList rows last (by that point nothing
 *      else references them, so the schema cascade is moot).
 *
 * Skips when `SKIP_DB_INTEGRATION=1` or `DATABASE_URL` is unset.
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
import { PrismaCatalogSettingsRepository } from './prisma-catalog-settings.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

const tenantSlug = (id: string): string => `cs-int-${id.slice(0, 8)}`;
const globalPriceListName = (id: string, suffix: string): string =>
  `cs-int-list-${id.slice(0, 8)}-${suffix}`;

describeIfDb('PrismaCatalogSettingsRepository (Integration - Real DB)', () => {
  let prisma: PrismaClient;
  let repo: PrismaCatalogSettingsRepository;
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
    // `Pick<ClsService<S>, 'get'>` produced TS2322 in first rerun).
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
    repo = new PrismaCatalogSettingsRepository(tenantPrisma);
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
        await prisma.productCatalogPriceList.deleteMany({
          where: { tenantId: { in: trackedTenantIds } },
        });
        await prisma.priceList.deleteMany({
          where: { tenantId: { in: trackedTenantIds } },
        });
        await prisma.product.deleteMany({
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
  async function seedTenant(label: 'A' | 'B'): Promise<string> {
    const id = randomUUID();
    await prisma.tenant.create({
      data: {
        id,
        name: `Catalog Settings Tenant ${label} ${id.slice(0, 8)}`,
        slug: tenantSlug(id),
        isActive: true,
        catalogPublished: false,
        catalogStockPresentationDefault: 'SYSTEM_STATUS',
      },
    });
    trackedTenantIds.push(id);
    return id;
  }

  async function seedGlobalPriceList(suffix: string): Promise<string> {
    const id = randomUUID();
    await prisma.globalPriceList.create({
      data: { id, name: globalPriceListName(id, suffix), isDefault: false },
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

  async function seedProduct(tenantId: string): Promise<string> {
    const id = randomUUID();
    await prisma.product.create({
      data: { id, tenantId, name: `CS INT Product ${id.slice(0, 8)}` },
    });
    return id;
  }

  async function seedPriceList(input: {
    tenantId: string;
    productId: string;
    globalPriceListId: string;
    priceCents: number;
  }): Promise<void> {
    await prisma.priceList.create({
      data: {
        tenantId: input.tenantId,
        productId: input.productId,
        globalPriceListId: input.globalPriceListId,
        priceCents: input.priceCents,
      },
    });
  }

  // ── Tests ──────────────────────────────────────────────────────────────

  describe('read isolation (T1 / T2)', () => {
    it('T1 — Tenant A reads its own settings/bindings and reconstructs names + default', async () => {
      const tenantA = await seedTenant('A');
      const tenantB = await seedTenant('B');
      const gDefault = await seedGlobalPriceList('default');
      const gExtra = await seedGlobalPriceList('extra');
      await seedBinding({
        tenantId: tenantA,
        globalPriceListId: gDefault,
        isCatalogDefault: true,
      });
      await seedBinding({
        tenantId: tenantA,
        globalPriceListId: gExtra,
        isCatalogDefault: false,
      });

      currentTenantId = tenantA;
      const aggregate = await repo.findByTenantId(tenantA);

      expect(aggregate).not.toBeNull();
      expect(aggregate?.tenantId).toBe(tenantA);
      expect(aggregate?.bindings).toHaveLength(2);
      const ids = aggregate!.bindings.map((b) => b.globalPriceListId);
      expect(ids).toContain(gDefault);
      expect(ids).toContain(gExtra);
      // Aggregate is sorted ascending by globalPriceListId by design.
      expect(ids[0] < ids[1]).toBe(true);
      // Default binding reconstruction — exactly one.
      expect(aggregate?.defaultBinding).not.toBeNull();
      expect(aggregate?.defaultBinding?.globalPriceListId).toBe(gDefault);
      expect(aggregate?.defaultBinding?.isCatalogDefault).toBe(true);
      // Names reconstructed from the joined GlobalPriceList projection.
      for (const b of aggregate!.bindings) {
        expect(b.globalPriceList.id).toBe(b.globalPriceListId);
        expect(b.globalPriceList.name).toMatch(/^cs-int-list-/);
      }
      // Tenant B's rows must not leak into the aggregate.
      const bindingTenantIds = aggregate!.bindings.map((b) => b.tenantId);
      expect(bindingTenantIds.every((t) => t === tenantA)).toBe(true);
      // No binding row in the aggregate belongs to the seeded neighbor.
      expect(bindingTenantIds).not.toContain(tenantB);
    });

    it('T2 — Tenant B read does not expose Tenant A settings/bindings', async () => {
      const tenantA = await seedTenant('A');
      const tenantB = await seedTenant('B');
      const gDefault = await seedGlobalPriceList('default');
      await seedBinding({
        tenantId: tenantA,
        globalPriceListId: gDefault,
        isCatalogDefault: true,
      });

      currentTenantId = tenantB;
      const tenantBRead = await repo.findByTenantId(tenantB);

      // Tenant B exists with no bindings → aggregate present, empty bindings.
      expect(tenantBRead).not.toBeNull();
      expect(tenantBRead?.tenantId).toBe(tenantB);
      expect(tenantBRead?.bindings).toHaveLength(0);
      expect(tenantBRead?.defaultBinding).toBeNull();
      const exposedIds =
        tenantBRead?.bindings.map((b) => b.globalPriceListId) ?? [];
      expect(exposedIds).not.toContain(gDefault);
      // Tenant A's binding row is intact and untouched.
      const aBindingCount = await prisma.tenantCatalogPriceList.count({
        where: { tenantId: tenantA },
      });
      expect(aBindingCount).toBe(1);
    });
  });

  describe('findByTenantId idempotence (T3)', () => {
    it('repeated findByTenantId returns identical aggregates and creates no rows', async () => {
      const tenantA = await seedTenant('A');
      const gDefault = await seedGlobalPriceList('default');
      const gExtra = await seedGlobalPriceList('extra');
      await seedBinding({
        tenantId: tenantA,
        globalPriceListId: gDefault,
        isCatalogDefault: true,
      });
      await seedBinding({
        tenantId: tenantA,
        globalPriceListId: gExtra,
        isCatalogDefault: false,
      });

      currentTenantId = tenantA;

      const beforeTenants = await prisma.tenant.count({
        where: { id: tenantA },
      });
      const beforeBindings = await prisma.tenantCatalogPriceList.count({
        where: { tenantId: tenantA },
      });

      const first = await repo.findByTenantId(tenantA);
      const second = await repo.findByTenantId(tenantA);

      const afterTenants = await prisma.tenant.count({
        where: { id: tenantA },
      });
      const afterBindings = await prisma.tenantCatalogPriceList.count({
        where: { tenantId: tenantA },
      });

      expect(afterTenants).toBe(beforeTenants);
      expect(afterBindings).toBe(beforeBindings);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();

      // Structural equality — same tenant, same binding ids (asc), same
      // default, same reconstructed names.
      expect(second?.tenantId).toBe(first?.tenantId);
      expect(second?.bindings).toHaveLength(first!.bindings.length);
      const firstIds = first!.bindings.map((b) => b.globalPriceListId);
      const secondIds = second!.bindings.map((b) => b.globalPriceListId);
      expect(secondIds).toEqual(firstIds);
      expect(second?.defaultBinding?.globalPriceListId).toBe(
        first?.defaultBinding?.globalPriceListId,
      );
      const firstNames = first!.bindings.map((b) => b.globalPriceList.name);
      const secondNames = second!.bindings.map((b) => b.globalPriceList.name);
      expect(secondNames).toEqual(firstNames);
    });
  });

  describe('findGlobalPriceListsByIds (T4)', () => {
    it('returns the requested existing subset and silently drops missing ids', async () => {
      const g1 = await seedGlobalPriceList('one');
      const g2 = await seedGlobalPriceList('two');
      const g3 = await seedGlobalPriceList('three');

      const subset = await repo.findGlobalPriceListsByIds([g1, g3]);
      const subsetIds = subset.map((r) => r.id).sort();
      expect(subsetIds).toEqual([g1, g3].sort());
      expect(subsetIds).not.toContain(g2);
      for (const row of subset) {
        expect(row.name).toMatch(/^cs-int-list-/);
      }

      // Mix a missing id in — must not crash, must not return it.
      const missing = randomUUID();
      const mixed = await repo.findGlobalPriceListsByIds([g2, missing]);
      expect(mixed.map((r) => r.id)).toEqual([g2]);
    });
  });

  describe('countDefaultContextCoverage (T5)', () => {
    it('scopes by tenant + globalPriceListId and counts only positive priceCents', async () => {
      const tenantA = await seedTenant('A');
      const tenantB = await seedTenant('B');
      const g1 = await seedGlobalPriceList('one');
      const g2 = await seedGlobalPriceList('two');

      // Tenant A on G1: 3 positive-priced products + 1 zero-priced row.
      // priceCents > 0 MUST EXCLUDE the zero row.
      for (let i = 0; i < 3; i += 1) {
        const productId = await seedProduct(tenantA);
        await seedPriceList({
          tenantId: tenantA,
          productId,
          globalPriceListId: g1,
          priceCents: (i + 1) * 100,
        });
      }
      const zeroPriceProductId = await seedProduct(tenantA);
      await seedPriceList({
        tenantId: tenantA,
        productId: zeroPriceProductId,
        globalPriceListId: g1,
        priceCents: 0,
      });

      // Tenant A on G2: 1 positive-priced row (proves list scoping).
      const aG2ProductId = await seedProduct(tenantA);
      await seedPriceList({
        tenantId: tenantA,
        productId: aG2ProductId,
        globalPriceListId: g2,
        priceCents: 999,
      });

      // Tenant B on G1: 2 positive-priced rows (cross-tenant noise that
      // MUST NOT count when scoping to Tenant A on G1).
      for (let i = 0; i < 2; i += 1) {
        const productId = await seedProduct(tenantB);
        await seedPriceList({
          tenantId: tenantB,
          productId,
          globalPriceListId: g1,
          priceCents: (i + 1) * 500,
        });
      }

      currentTenantId = tenantA;
      const aG1Count = await repo.countDefaultContextCoverage(tenantA, g1);
      const aG2Count = await repo.countDefaultContextCoverage(tenantA, g2);
      expect(aG1Count).toBe(3); // positive only, zero excluded
      expect(aG2Count).toBe(1); // list-scoped to G2

      currentTenantId = tenantB;
      const bG1Count = await repo.countDefaultContextCoverage(tenantB, g1);
      expect(bG1Count).toBe(2); // tenant-scoped to Tenant B

      // Cross-tenant probe — Tenant B context calling with tenantA arg.
      // CLS injection overrides the explicit arg → count is Tenant B's.
      const crossCount = await repo.countDefaultContextCoverage(tenantA, g1);
      expect(crossCount).toBe(2);
      expect(crossCount).not.toBe(3);
    });
  });
});
