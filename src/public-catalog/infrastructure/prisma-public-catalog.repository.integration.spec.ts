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
 * projection with no name/default-flag fallback.
 *
 * F1.WU5e3 adds real-DB cart evidence through `ValidatePublicCartUseCase`
 * (real tenant-scoped Prisma + real `PrismaPublicCatalogRepository`, spies
 * only observing): publication membership/redaction/order with repeat
 * idempotence, exact tenant catalog-default pricing with the resolver
 * called exactly once per request, and missing-default fail-closed
 * `PRICE_HIDDEN` shape.
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
import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

const tenantSlug = (id: string): string => `pc-int-${id.slice(0, 8)}`;

describeIfDb('PrismaPublicCatalogRepository (Integration - Real DB)', () => {
  let prisma: PrismaClient;
  let repo: PrismaPublicCatalogRepository;
  let useCase: ValidatePublicCartUseCase;
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
    // F1.WU5e3 — real use case over the real tenant-scoped client and
    // the real repository above (no read is ever replaced).
    useCase = new ValidatePublicCartUseCase(tenantPrisma, repo);
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
    // Post-run gate: the explicit FK-safe cleanup above (no truncate)
    // must leave zero rows carrying this suite's randomized fixture
    // prefixes. Any residual row is a leak and fails the run.
    const [tenants, products, variants, globalLists] = await Promise.all([
      prisma.tenant.count({ where: { slug: { startsWith: 'pc-int-' } } }),
      prisma.product.count({ where: { sku: { startsWith: 'pc-int-' } } }),
      prisma.variant.count({
        where: { sku: { startsWith: 'pc-int-v-' } },
      }),
      prisma.globalPriceList.count({
        where: { name: { startsWith: 'pc-int-' } },
      }),
    ]);
    expect([tenants, products, variants, globalLists]).toEqual([0, 0, 0, 0]);
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
      quantity?: number;
      nameTag?: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await prisma.product.create({
      data: {
        id,
        name: `PC INT Product ${opts?.nameTag ?? label} ${id.slice(0, 8)}`,
        type: opts?.type ?? 'PRODUCT',
        quantity: opts?.quantity,
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
    opts?: { quantity?: number },
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
        quantity: opts?.quantity,
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

  // F1.WU5e3 fixture helpers (cart evidence). Images cascade with the
  // product, so no separate tracking is needed.
  async function seedImage(
    tenantId: string,
    productId: string,
    marker: string,
  ): Promise<string> {
    const url = `https://cdn.example.com/${marker}-${randomUUID()}.jpg`;
    await prisma.productImage.create({
      data: { productId, tenantId, url, isMain: true },
    });
    return url;
  }

  async function fixtureCounts(
    tenantId: string,
  ): Promise<Record<string, number>> {
    return {
      products: await prisma.product.count({ where: { tenantId } }),
      variants: await prisma.variant.count({ where: { tenantId } }),
      priceLists: await prisma.priceList.count({ where: { tenantId } }),
      variantPrices: await prisma.variantPrice.count({ where: { tenantId } }),
      images: await prisma.productImage.count({ where: { tenantId } }),
      bindings: await prisma.tenantCatalogPriceList.count({
        where: { tenantId },
      }),
    };
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

  // ── F1.WU5e3 — real-DB cart evidence (ValidatePublicCartUseCase) ──────
  describe('F1.WU5e3 — cart publication/default-price/idempotence', () => {
    it('keeps only effectively published rows, preserves input order, redacts blocked rows, and repeats identically', async () => {
      const a = (
        await seedTenant('A', { isActive: true, catalogPublished: true })
      ).id;
      currentTenantId = a;

      const gExact = await seedGlobalPriceList('cart-gates');
      await seedBinding({
        tenantId: a,
        globalPriceListId: gExact,
        isCatalogDefault: true,
      });

      // Published included non-variant PRODUCT: image + exact price.
      const plain = await seedProduct(a, 'plain', { quantity: 50 });
      await seedProductPrice(a, plain, gExact, 1000);
      const plainImgUrl = await seedImage(a, plain, 'plain-img-ok');

      // Blocked rows carry secret name/image markers and poison prices
      // that must never reach the cart output.
      const service = await seedProduct(a, 'service', {
        type: 'SERVICE',
        quantity: 9,
        nameTag: 'svc-secret-a',
      });
      await seedProductPrice(a, service, gExact, 7654321);
      await seedImage(a, service, 'svc-secret-img-a');

      const fParent = await seedProduct(a, 'f-parent', {
        include: false,
        variants: true,
        quantity: 9,
        nameTag: 'parent-secret-a',
      });
      const onChild = await seedVariant(fParent, a, 'on', 'ON', {
        quantity: 9,
      });
      const onChildPriceRow = await seedProductPrice(
        a,
        fParent,
        gExact,
        7654322,
      );
      await seedVariantPrice(a, onChild, onChildPriceRow, 8765432);

      const mixed = await seedProduct(a, 'mixed', {
        variants: true,
        quantity: 40,
      });
      const inheritV = await seedVariant(mixed, a, 'inherit', 'INHERIT', {
        quantity: 30,
      });
      const offV = await seedVariant(mixed, a, 'off', 'OFF', {
        quantity: 30,
      });
      const mixedPriceRow = await seedProductPrice(a, mixed, gExact, 3000);
      await seedVariantPrice(a, inheritV, mixedPriceRow, 2111);
      await seedVariantPrice(a, offV, mixedPriceRow, 8765433);

      const input = {
        items: [
          { productId: plain, quantity: 2 },
          { productId: service, quantity: 1 },
          { productId: mixed, variantId: inheritV, quantity: 3 },
          { productId: fParent, variantId: onChild, quantity: 1 },
          { productId: mixed, variantId: offV, quantity: 1 },
        ],
      };

      const result = await useCase.execute(input);

      // Input order preserved 1:1.
      expect(result.items.map((i) => i.productId)).toEqual([
        plain,
        service,
        mixed,
        fParent,
        mixed,
      ]);

      // Published non-variant PRODUCT continues with metadata + price.
      expect(result.items[0].productName).toBe(
        `PC INT Product plain ${plain.slice(0, 8)}`,
      );
      expect(result.items[0]).toMatchObject({
        variantId: null,
        image: { url: plainImgUrl },
        quantity: 2,
        unitPriceCents: 1000,
        lineTotalCents: 2000,
        availability: 'available',
        priceHidden: false,
        warnings: [],
      });

      // Mixed product: INHERIT variant continues on the exact price.
      expect(result.items[2].productName).toBe(
        `PC INT Product mixed ${mixed.slice(0, 8)}`,
      );
      expect(result.items[2].variantName).toBe(
        `PC INT Variant inherit ${inheritV.slice(0, 8)}`,
      );
      expect(result.items[2]).toMatchObject({
        variantId: inheritV,
        unitPriceCents: 2111,
        lineTotalCents: 6333,
        availability: 'available',
        priceHidden: false,
        warnings: [],
      });

      // SERVICE → NOT_IN_CATALOG; include=false parent + ON child →
      // NOT_IN_CATALOG (ON never widens a false parent); OFF variant →
      // VARIANT_NOT_FOUND. All blocked rows reuse the existing F1
      // sanitized shape: no product/variant/image metadata, no prices.
      const blocked = [
        { index: 1, warning: 'NOT_IN_CATALOG' },
        { index: 3, warning: 'NOT_IN_CATALOG' },
        { index: 4, warning: 'VARIANT_NOT_FOUND' },
      ] as const;
      for (const { index, warning } of blocked) {
        expect(result.items[index].warnings).toEqual([warning]);
        expect(result.items[index].productName).toBe('');
        expect(result.items[index].variantName).toBeNull();
        expect(result.items[index].image).toBeNull();
        expect(result.items[index].unitPriceCents).toBeNull();
        expect(result.items[index].lineTotalCents).toBeNull();
        expect(result.items[index].availability).toBe('out_of_stock');
        expect(result.items[index].priceHidden).toBe(false);
      }
      // Blocked variant IDs echo the request but stay blocked.
      expect(result.items[3].variantId).toBe(onChild);
      expect(result.items[4].variantId).toBe(offV);

      expect(result.valid).toBe(false);
      expect(result.totalCents).toBe(8333); // 2000 + 6333
      expect(result.warnings).toEqual(['NOT_IN_CATALOG', 'VARIANT_NOT_FOUND']);

      // Blocked rows disclose none of their secret metadata or prices.
      const blob = JSON.stringify(result);
      for (const secret of [
        'svc-secret-a',
        'parent-secret-a',
        '7654321',
        '7654322',
        '8765432',
        '8765433',
      ]) {
        expect(blob).not.toContain(secret);
      }

      // Same input validates identically; pure reads keep counts.
      const before = await fixtureCounts(a);
      const repeat = await useCase.execute(input);
      expect(repeat).toEqual(result);
      expect(await fixtureCounts(a)).toEqual(before);
    });

    it('prices only from the exact tenant-bound non-default list, resolving it exactly once per request', async () => {
      const b = (
        await seedTenant('B', { isActive: true, catalogPublished: true })
      ).id;
      currentTenantId = b;

      // Exact list: deliberately isDefault=false with an obscure name.
      // Shadow lure: sole isDefault=true row with a default-like name
      // and distinct prices — any legacy isDefault/name fallback would
      // leak shadow cents into the cart.
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

      const fixtureRows = await prisma.globalPriceList.findMany({
        where: { id: { in: [gExact, gShadow] } },
      });
      const exactRow = fixtureRows.find((r) => r.id === gExact)!;
      const shadowRow = fixtureRows.find((r) => r.id === gShadow)!;
      expect(exactRow.isDefault).toBe(false);
      expect(shadowRow.isDefault).toBe(true);
      expect(exactRow.name).not.toContain('default');
      expect(shadowRow.name).toContain('default');

      await seedBinding({
        tenantId: b,
        globalPriceListId: gExact,
        isCatalogDefault: true,
      });

      const solo = await seedProduct(b, 'solo', { quantity: 30 });
      await seedProductPrice(b, solo, gExact, 3100);
      await seedProductPrice(b, solo, gShadow, 9100911);

      const mixed = await seedProduct(b, 'mixed', {
        variants: true,
        quantity: 30,
      });
      const inheritV = await seedVariant(mixed, b, 'inherit', 'INHERIT', {
        quantity: 30,
      });
      const onV = await seedVariant(mixed, b, 'on', 'ON', {
        quantity: 30,
      });
      const mixedExact = await seedProductPrice(b, mixed, gExact, 3000);
      const mixedShadow = await seedProductPrice(b, mixed, gShadow, 9200922);
      await seedVariantPrice(b, inheritV, mixedExact, 3200);
      await seedVariantPrice(b, inheritV, mixedShadow, 9300933);
      await seedVariantPrice(b, onV, mixedExact, 3300);

      // Observe-only spy: the real resolver implementation stays in place.
      const resolverSpy = jest.spyOn(
        repo,
        'findTenantCatalogDefaultPriceListId',
      );

      const result = await useCase.execute({
        items: [
          { productId: solo, quantity: 2 },
          { productId: solo, quantity: 1 },
          { productId: mixed, variantId: inheritV, quantity: 1 },
          { productId: mixed, variantId: onV, quantity: 1 },
        ],
      });

      // Exactly one resolver call per validation request, reused for
      // duplicates and multiple items, bound to the exact global ID.
      expect(resolverSpy).toHaveBeenCalledTimes(1);
      expect(await resolverSpy.mock.results[0].value).toBe(gExact);

      const units = result.items.map((i) => i.unitPriceCents);
      const lines = result.items.map((i) => i.lineTotalCents);
      expect(units).toEqual([3100, 3100, 3200, 3300]);
      expect(lines).toEqual([6200, 3100, 3200, 3300]);
      expect(result.valid).toBe(true);
      expect(result.totalCents).toBe(15800);
      expect(result.warnings).toEqual([]);

      // Shadow-list cents leak nowhere.
      const blob = JSON.stringify(result);
      expect(blob).not.toContain('9100911');
      expect(blob).not.toContain('9200922');
      expect(blob).not.toContain('9300933');

      // A second request resolves exactly once again (once per request).
      const repeat = await useCase.execute({
        items: [{ productId: solo, quantity: 1 }],
      });
      expect(resolverSpy).toHaveBeenCalledTimes(2);
      expect(repeat.items[0].unitPriceCents).toBe(3100);
    });

    it('missing catalog-default binding fails closed to PRICE_HIDDEN without throw and without weakening publication gates', async () => {
      const c = (
        await seedTenant('C', { isActive: true, catalogPublished: true })
      ).id;
      currentTenantId = c;

      // Published product whose only price sits on an UNBOUND global
      // list: no isCatalogDefault binding exists for this tenant.
      const gOrphan = await seedGlobalPriceList('orphan-list');
      const priced = await seedProduct(c, 'priced', { quantity: 10 });
      await seedProductPrice(c, priced, gOrphan, 4200420);
      const service = await seedProduct(c, 'service', {
        type: 'SERVICE',
        quantity: 10,
        nameTag: 'svc-secret-c',
      });

      expect(
        await prisma.tenantCatalogPriceList.count({
          where: { tenantId: c },
        }),
      ).toBe(0);

      const result = await useCase.execute({
        items: [
          { productId: priced, quantity: 2 },
          { productId: service, quantity: 1 },
        ],
      });

      expect(result.items[0]).toMatchObject({
        variantId: null,
        unitPriceCents: null,
        lineTotalCents: null,
        availability: 'available',
        priceHidden: true,
        warnings: ['PRICE_HIDDEN'],
      });
      expect(result.items[0].productName).not.toBe('');

      // Publication gates stay fully in force without a default.
      expect(result.items[1]).toMatchObject({
        warnings: ['NOT_IN_CATALOG'],
        productName: '',
        variantName: null,
        image: null,
        unitPriceCents: null,
        lineTotalCents: null,
      });

      // PRICE_HIDDEN is non-blocking, but the blocked SERVICE row is;
      // totals still fail closed to null.
      expect(result.valid).toBe(false);
      expect(result.totalCents).toBeNull();
      expect(result.warnings).toEqual(['PRICE_HIDDEN', 'NOT_IN_CATALOG']);

      // The real withheld price never leaks into the response.
      const blob = JSON.stringify(result);
      expect(blob).not.toContain('4200420');
      expect(blob).not.toContain('svc-secret-c');
    });
  });
});
