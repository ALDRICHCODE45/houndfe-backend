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
 *
 * F1.WU5e2 adds product/variant publication-gate evidence: list/detail
 * survivorship (excluded, SERVICE, all-OFF, false-parent+ON non-widening,
 * mixed INHERIT/ON/OFF), tenant isolation, and exact-global-price-list
 * projection with no name/default-flag fallback. Cart/use-case integration
 * is deliberately out of scope (WU5e3).
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
  // F1.WU5e2 tracked rows — deleted FK-safe before tenants/globals.
  const trackedProductIds: string[] = [];
  const trackedVariantIds: string[] = [];
  const trackedProductPriceRowIds: string[] = [];
  const trackedVariantPriceRowIds: string[] = [];

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
      // F1.WU5e2 FK-safe order: variant prices → variants → product
      // prices (PriceList rows) → products → tenants/globals.
      if (trackedVariantPriceRowIds.length > 0) {
        await prisma.variantPrice.deleteMany({
          where: { id: { in: trackedVariantPriceRowIds } },
        });
      }
      if (trackedVariantIds.length > 0) {
        await prisma.variant.deleteMany({
          where: { id: { in: trackedVariantIds } },
        });
      }
      if (trackedProductPriceRowIds.length > 0) {
        await prisma.priceList.deleteMany({
          where: { id: { in: trackedProductPriceRowIds } },
        });
      }
      if (trackedProductIds.length > 0) {
        await prisma.product.deleteMany({
          where: { id: { in: trackedProductIds } },
        });
      }
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
      trackedProductIds.length = 0;
      trackedVariantIds.length = 0;
      trackedProductPriceRowIds.length = 0;
      trackedVariantPriceRowIds.length = 0;
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

  // ── F1.WU5e2 fixture helpers (products/variants/prices) ─────────────
  async function seedProduct(
    tenantId: string,
    label: string,
    opts?: {
      include?: boolean;
      type?: 'PRODUCT' | 'SERVICE';
      variants?: boolean;
    },
  ): Promise<string> {
    const id = randomUUID();
    await prisma.product.create({
      data: {
        id,
        name: `PC INT Product ${label} ${id.slice(0, 8)}`,
        type: opts?.type ?? 'PRODUCT',
        tenantId,
        includeInOnlineCatalog: opts?.include ?? true,
        hasVariants: opts?.variants ?? false,
        sku: `pc-int-${id.slice(0, 8)}`,
      },
    });
    trackedProductIds.push(id);
    return id;
  }

  async function seedVariant(
    productId: string,
    tenantId: string,
    label: string,
    mode: 'INHERIT' | 'ON' | 'OFF',
  ): Promise<string> {
    const id = randomUUID();
    await prisma.variant.create({
      data: {
        id,
        productId,
        tenantId,
        name: `PC INT Variant ${label} ${id.slice(0, 8)}`,
        option: 'color',
        value: label,
        catalogPublishMode: mode,
        sku: `pc-int-v-${id.slice(0, 8)}`,
      },
    });
    trackedVariantIds.push(id);
    return id;
  }

  async function seedProductPrice(
    tenantId: string,
    productId: string,
    globalPriceListId: string,
    priceCents: number,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.priceList.create({
      data: { id, productId, tenantId, globalPriceListId, priceCents },
    });
    trackedProductPriceRowIds.push(id);
    return id;
  }

  async function seedVariantPrice(
    tenantId: string,
    variantId: string,
    productPriceRowId: string,
    priceCents: number,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.variantPrice.create({
      data: {
        id,
        variantId,
        tenantId,
        priceListId: productPriceRowId,
        priceCents,
      },
    });
    trackedVariantPriceRowIds.push(id);
    return id;
  }

  const listParams = { sort: 'newest' as const, page: 1, limit: 20 };

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

  // ── F1.WU5e2 — product/variant publication evidence (real DB) ────────
  describe('F1.WU5e2 — product/variant publication gates', () => {
    it('list + count return only effective published parents, in deterministic API order', async () => {
      const a = (
        await seedTenant('A', { isActive: true, catalogPublished: true })
      ).id;
      currentTenantId = a;

      const plain = await seedProduct(a, 'plain');
      const excluded = await seedProduct(a, 'excluded', { include: false });
      const service = await seedProduct(a, 'service', { type: 'SERVICE' });
      const allOff = await seedProduct(a, 'all-off', { variants: true });
      await seedVariant(allOff, a, 'off-a', 'OFF');
      await seedVariant(allOff, a, 'off-b', 'OFF');
      const mixed = await seedProduct(a, 'mixed', { variants: true });
      await seedVariant(mixed, a, 'inherit', 'INHERIT');
      await seedVariant(mixed, a, 'on', 'ON');
      await seedVariant(mixed, a, 'off', 'OFF');
      const fParent = await seedProduct(a, 'f-parent', {
        include: false,
        variants: true,
      });
      await seedVariant(fParent, a, 'on', 'ON');

      const result = await repo.findProducts(listParams);

      // Fresh tenant — the scoped client guarantees no baseline rows, so
      // the total is exactly the two effective published parents.
      expect(result.total).toBe(2);

      // Deterministic API order (createdAt desc) read back from the DB.
      const expectedOrder = await prisma.product.findMany({
        where: { id: { in: [plain, mixed] } },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      expect(result.items.map((p) => p.id)).toEqual(
        expectedOrder.map((p) => p.id),
      );

      const returnedIds = result.items.map((p) => p.id);
      for (const dead of [excluded, service, allOff, fParent]) {
        expect(returnedIds).not.toContain(dead);
      }
    });

    it('detail returns null for excluded/SERVICE/all-OFF/false-parent+ON and prunes OFF from the mixed product', async () => {
      const a = (
        await seedTenant('A', { isActive: true, catalogPublished: true })
      ).id;
      currentTenantId = a;

      const excluded = await seedProduct(a, 'excluded', { include: false });
      const service = await seedProduct(a, 'service', { type: 'SERVICE' });
      const allOff = await seedProduct(a, 'all-off', { variants: true });
      await seedVariant(allOff, a, 'off', 'OFF');
      const fParent = await seedProduct(a, 'f-parent', {
        include: false,
        variants: true,
      });
      const onChild = await seedVariant(fParent, a, 'on', 'ON');
      const mixed = await seedProduct(a, 'mixed', { variants: true });
      const inheritV = await seedVariant(mixed, a, 'inherit', 'INHERIT');
      const onV = await seedVariant(mixed, a, 'on', 'ON');
      const offV = await seedVariant(mixed, a, 'off', 'OFF');

      for (const dead of [excluded, service, allOff, fParent]) {
        expect(await repo.findProductById(dead)).toBeNull();
      }

      const detail = await repo.findProductById(mixed);
      expect(detail).not.toBeNull();
      const variantIds = detail!.variants.map((v) => v.id);
      expect(variantIds).toEqual(expect.arrayContaining([inheritV, onV]));
      expect(variantIds).not.toContain(offV);
      expect(variantIds).not.toContain(onChild); // non-widening sanity
      expect(variantIds).toHaveLength(2);
    });

    it('tenant B products/variants never appear in tenant A list or detail', async () => {
      const a = (
        await seedTenant('A', { isActive: true, catalogPublished: true })
      ).id;
      const b = (
        await seedTenant('B', { isActive: true, catalogPublished: true })
      ).id;
      const aProduct = await seedProduct(a, 'a-only');
      const bProduct = await seedProduct(b, 'b-only', { variants: true });
      await seedVariant(bProduct, b, 'on', 'ON');

      currentTenantId = a;
      const aList = await repo.findProducts(listParams);
      expect(aList.total).toBe(1);
      expect(aList.items.map((p) => p.id)).toEqual([aProduct]);
      expect(await repo.findProductById(bProduct)).toBeNull();

      currentTenantId = b;
      expect(await repo.findProductById(bProduct)).not.toBeNull();
      expect(await repo.findProductById(aProduct)).toBeNull();
    });

    it('list/detail price projections use only the exact requested global ID — no name/default-flag fallback', async () => {
      const a = (
        await seedTenant('A', { isActive: true, catalogPublished: true })
      ).id;
      currentTenantId = a;

      // Polarity (corrected per independent review): the EXACT list is
      // deliberately isDefault=false with an obscure name; the SHADOW
      // list is the SOLE isDefault=true row of the pair and carries an
      // explicit default-like name. A faulty legacy isDefault or name
      // fallback therefore lures onto the shadow list and its wrong
      // prices (9999/2999) — never onto the exact list (1111/2111).
      // The tenant binding still points at the non-default exact list,
      // so resolution must come from the binding, not any global flag.
      const gExact = await seedGlobalPriceList('obscure-xq7n');
      const gShadow = randomUUID();
      await prisma.globalPriceList.create({
        data: {
          id: gShadow,
          name: `pc-int-legacy-global-default-${gShadow.slice(0, 8)}`,
          isDefault: true,
        },
      });
      trackedGlobalPriceListIds.push(gShadow);

      // Assert fixture polarity directly by ID/name/default flag BEFORE
      // any repository read, scoped to these two IDs only: only the
      // shadow is a valid global-default/name lure.
      const fixtureRows = await prisma.globalPriceList.findMany({
        where: { id: { in: [gExact, gShadow] } },
      });
      expect(fixtureRows).toHaveLength(2);
      const exactListRow = fixtureRows.find((r) => r.id === gExact);
      const shadowListRow = fixtureRows.find((r) => r.id === gShadow);
      expect(exactListRow).toBeDefined();
      expect(shadowListRow).toBeDefined();
      expect(exactListRow!.isDefault).toBe(false);
      expect(exactListRow!.name).not.toContain('default');
      expect(shadowListRow!.isDefault).toBe(true);
      expect(shadowListRow!.name).toContain('default');

      // A legacy take-one isDefault fallback scoped to the two IDs
      // selects the shadow lure, never the exact list.
      const fallbackLure = await prisma.globalPriceList.findFirst({
        where: { id: { in: [gExact, gShadow] }, isDefault: true },
      });
      expect(fallbackLure!.id).toBe(gShadow);

      await seedBinding({
        tenantId: a,
        globalPriceListId: gExact,
        isCatalogDefault: true,
      });

      const mixed = await seedProduct(a, 'mixed', { variants: true });
      const inheritV = await seedVariant(mixed, a, 'inherit', 'INHERIT');
      const onV = await seedVariant(mixed, a, 'on', 'ON');
      await seedVariant(mixed, a, 'off', 'OFF');

      const exactRow = await seedProductPrice(a, mixed, gExact, 1111);
      const shadowRow = await seedProductPrice(a, mixed, gShadow, 9999);
      await seedVariantPrice(a, inheritV, exactRow, 2111);
      await seedVariantPrice(a, inheritV, shadowRow, 2999);
      await seedVariantPrice(a, onV, exactRow, 2211);

      const resolved = await repo.findTenantCatalogDefaultPriceListId();
      expect(resolved).toBe(gExact);

      const listed = await repo.findProducts({
        ...listParams,
        globalPriceListId: resolved!,
      });
      const listedMixed = listed.items.find((p) => p.id === mixed);
      expect(listedMixed).toBeDefined();
      expect(listedMixed!.priceLists).toEqual([{ priceCents: 1111 }]);
      expect(
        listedMixed!.variants.find((v) => v.id === inheritV)!.variantPrices,
      ).toEqual([{ priceCents: 2111 }]);
      expect(
        listedMixed!.variants.find((v) => v.id === onV)!.variantPrices,
      ).toEqual([{ priceCents: 2211 }]);

      const detail = await repo.findProductById(mixed, resolved!);
      expect(detail).not.toBeNull();
      expect(detail!.priceLists).toEqual([{ priceCents: 1111 }]);
      expect(
        detail!.variants.find((v) => v.id === inheritV)!.variantPrices,
      ).toEqual([{ priceCents: 2111 }]);
      expect(detail!.variants.find((v) => v.id === onV)!.variantPrices).toEqual(
        [{ priceCents: 2211 }],
      );

      // Shadow-list cents (9999/2999) must appear nowhere.
      const blob = JSON.stringify([listed, detail]);
      expect(blob).not.toContain('9999');
      expect(blob).not.toContain('2999');
    });
  });
});
