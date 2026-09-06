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
import type { ResolvedPublicCatalogContext } from '../application/ports/public-catalog.repository';
import type { ProductDetailWithIncludes } from '../application/mappers/public-product.mapper';

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
  // F2.WU6 slice 3 — categories are global; delete after products.
  const trackedCategoryIds: string[] = [];

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
      if (trackedCategoryIds.length > 0) {
        await prisma.category.deleteMany({
          where: { id: { in: trackedCategoryIds } },
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
      trackedCategoryIds.length = 0;
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
      hidePrice?: boolean;
      requiresPrescription?: boolean;
      categoryId?: string;
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
        hidePriceInOnlineCatalog: opts?.hidePrice ?? false,
        requiresPrescription: opts?.requiresPrescription ?? false,
        hasVariants: opts?.variants ?? false,
        categoryId: opts?.categoryId,
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

  // Allowlist rows cascade with their product — no extra tracking.
  async function seedAllowlistRow(
    tenantId: string,
    productId: string,
    globalPriceListId: string,
  ): Promise<void> {
    await prisma.productCatalogPriceList.create({
      data: { id: randomUUID(), tenantId, productId, globalPriceListId },
    });
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

  // ── F2.WU6 slice 3 fixture helper (category facets) ─────────────────
  async function seedCategory(label: string): Promise<string> {
    const id = randomUUID();
    await prisma.category.create({
      data: { id, name: `pc-int-cat-${label}-${id.slice(0, 8)}` },
    });
    trackedCategoryIds.push(id);
    return id;
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

  // ── F2.WU6 (slice 1) — resolveTenantCatalogContext real-DB evidence ────
  describe('F2.WU6 resolveTenantCatalogContext', () => {
    it('resolves an explicit public binding with exact tenant/list identity', async () => {
      const tenant = await seedTenant('ctx-explicit', {
        isActive: true,
        catalogPublished: true,
      });
      const listId = await seedGlobalPriceList('ctx-explicit');
      await seedBinding({
        tenantId: tenant.id,
        globalPriceListId: listId,
        isCatalogDefault: false,
      });
      currentTenantId = tenant.id;

      await expect(
        repo.resolveTenantCatalogContext?.(tenantSlug(tenant.id), listId),
      ).resolves.toEqual({
        tenantId: tenant.id,
        tenantSlug: tenantSlug(tenant.id),
        globalPriceListId: listId,
        name: `pc-int-list-${listId.slice(0, 8)}-ctx-explicit`,
        isCatalogDefault: false,
      });
    });

    it('resolves the omitted ID to the catalog-default binding', async () => {
      const tenant = await seedTenant('ctx-default', {
        isActive: true,
        catalogPublished: true,
      });
      const listId = await seedGlobalPriceList('ctx-default');
      await seedBinding({
        tenantId: tenant.id,
        globalPriceListId: listId,
        isCatalogDefault: true,
      });
      currentTenantId = tenant.id;

      await expect(
        repo.resolveTenantCatalogContext?.(tenantSlug(tenant.id)),
      ).resolves.toMatchObject({
        tenantId: tenant.id,
        globalPriceListId: listId,
        isCatalogDefault: true,
      });
    });

    it('misses generically for nonexistent/unbound/cross-tenant/absent-default/unpublished', async () => {
      const tenantA = await seedTenant('ctx-miss-a', {
        isActive: true,
        catalogPublished: true,
      });
      await seedBinding({
        tenantId: tenantA.id,
        globalPriceListId: await seedGlobalPriceList('ctx-a'),
        isCatalogDefault: true,
      });
      const tenantB = await seedTenant('ctx-miss-b', {
        isActive: true,
        catalogPublished: true,
      });
      const listB = await seedGlobalPriceList('ctx-b');
      await seedBinding({
        tenantId: tenantB.id,
        globalPriceListId: listB,
        isCatalogDefault: true,
      });
      currentTenantId = tenantA.id;

      await expect(
        repo.resolveTenantCatalogContext?.(
          tenantSlug(tenantA.id),
          randomUUID(),
        ),
      ).resolves.toBeNull();
      const privateList = await seedGlobalPriceList('ctx-private');
      await expect(
        repo.resolveTenantCatalogContext?.(tenantSlug(tenantA.id), privateList),
      ).resolves.toBeNull();
      await expect(
        repo.resolveTenantCatalogContext?.(tenantSlug(tenantA.id), listB),
      ).resolves.toBeNull();

      const tenantC = await seedTenant('ctx-nodefault', {
        isActive: true,
        catalogPublished: true,
      });
      await seedBinding({
        tenantId: tenantC.id,
        globalPriceListId: await seedGlobalPriceList('ctx-c'),
        isCatalogDefault: false,
      });
      currentTenantId = tenantC.id;
      await expect(
        repo.resolveTenantCatalogContext?.(tenantSlug(tenantC.id)),
      ).resolves.toBeNull();

      const tenantD = await seedTenant('ctx-unpub', {
        isActive: false,
        catalogPublished: false,
      });
      await seedBinding({
        tenantId: tenantD.id,
        globalPriceListId: await seedGlobalPriceList('ctx-d'),
        isCatalogDefault: true,
      });
      currentTenantId = tenantD.id;
      await expect(
        repo.resolveTenantCatalogContext?.(tenantSlug(tenantD.id)),
      ).resolves.toBeNull();
    });
  });

  // ── F2.WU6 (slice 2) — listPublicProducts items-only seam ────────────
  describe('F2.WU6 listPublicProducts — exact-context eligibility', () => {
    it('returns only eligible items for the selected context and paginates after DB filtering', async () => {
      const tenant = (
        await seedTenant('lp', { isActive: true, catalogPublished: true })
      ).id;
      // Second tenant owns ONLY the cross-tenant relation rows below.
      const other = (
        await seedTenant('lp-x', { isActive: true, catalogPublished: true })
      ).id;
      currentTenantId = tenant;

      const gSel = await seedGlobalPriceList('lp-sel');
      const gOther = await seedGlobalPriceList('lp-other');
      await seedBinding({
        tenantId: tenant,
        globalPriceListId: gSel,
        isCatalogDefault: true,
      });

      // Eligible: positive price; non-empty allowlist MATCHING the list.
      const supported = await seedProduct(tenant, 'supported');
      await seedProductPrice(tenant, supported, gSel, 1500);
      await seedAllowlistRow(tenant, supported, gSel);
      // Excluded: non-empty allowlist that misses the selected list.
      const unsupported = await seedProduct(tenant, 'unsupported');
      await seedProductPrice(tenant, unsupported, gSel, 1600);
      await seedAllowlistRow(tenant, unsupported, gOther);
      // Excluded: same-tenant allowlist miss — a wrong-tenant allowlist row matching the selected list must not rescue.
      const crossRescue = await seedProduct(tenant, 'cross-rescue');
      await seedProductPrice(tenant, crossRescue, gSel, 1200);
      await seedAllowlistRow(tenant, crossRescue, gOther);
      await seedAllowlistRow(other, crossRescue, gSel);
      // Excluded: zero selected price; alternate-list positive never rescues.
      const zeroSel = await seedProduct(tenant, 'zero-sel');
      await seedProductPrice(tenant, zeroSel, gSel, 0);
      await seedProductPrice(tenant, zeroSel, gOther, 9999);

      // Eligible (hidden-price precedence): variant-backed with ONLY alternate-list variant price — none may surface.
      const hidden = await seedProduct(tenant, 'hidden', {
        variants: true,
        hidePrice: true,
      });
      const hPriceRow = await seedProductPrice(tenant, hidden, gOther, 8888);
      const hiddenV = await seedVariant(hidden, tenant, 'vh', 'INHERIT');
      await seedVariantPrice(tenant, hiddenV, hPriceRow, 9500);
      await seedAllowlistRow(tenant, hidden, gOther);

      // Eligible (prescription precedence): variant-backed; the zero-cents selected variant price must not surface.
      const rx = await seedProduct(tenant, 'rx', {
        variants: true,
        requiresPrescription: true,
      });
      const rxPriceRow = await seedProductPrice(tenant, rx, gSel, 0);
      const rxV = await seedVariant(rx, tenant, 'vr', 'INHERIT');
      await seedVariantPrice(tenant, rxV, rxPriceRow, 0);
      await seedAllowlistRow(tenant, rx, gOther);

      // Eligible: BOTH a positive selected product price row AND a positive selected variant price.
      const variantOk = await seedProduct(tenant, 'variant-ok', {
        variants: true,
      });
      const okPriceRow = await seedProductPrice(tenant, variantOk, gSel, 2500);
      const okV = await seedVariant(variantOk, tenant, 'vok', 'INHERIT');
      await seedVariantPrice(tenant, okV, okPriceRow, 2600);

      // Excluded (BOTH, product side): positive selected VARIANT price, no positive PRODUCT price row.
      const noProdPrice = await seedProduct(tenant, 'variant-npp', {
        variants: true,
      });
      const nppRow = await seedProductPrice(tenant, noProdPrice, gSel, 0);
      await seedProductPrice(tenant, noProdPrice, gOther, 6600);
      const nppV = await seedVariant(noProdPrice, tenant, 'vnpp', 'INHERIT');
      await seedVariantPrice(tenant, nppV, nppRow, 5000);

      // Excluded (C2): positive product price, nonpositive variant price.
      const nvp = await seedProduct(tenant, 'variant-nvp', {
        variants: true,
      });
      const nvpRow = await seedProductPrice(tenant, nvp, gSel, 3000);
      const nvpV = await seedVariant(nvp, tenant, 'vnvp', 'INHERIT');
      await seedVariantPrice(tenant, nvpV, nvpRow, 0);

      // Excluded (C2): bypass still needs a same-tenant published variant.
      const crossOnly = await seedProduct(tenant, 'cross-only', {
        variants: true,
        hidePrice: true,
        requiresPrescription: true,
      });
      const crossRow = await seedProductPrice(other, crossOnly, gSel, 7000);
      const crossV = await seedVariant(crossOnly, other, 'vcross', 'INHERIT');
      await seedVariantPrice(other, crossV, crossRow, 7100);

      // Eligible: own rows qualify despite a cross-tenant allowlist row — tenant B rows neither qualify nor disqualify.
      const crossAllowed = await seedProduct(tenant, 'cross-ok');
      await seedProductPrice(tenant, crossAllowed, gSel, 1800);
      await seedAllowlistRow(other, crossAllowed, gOther);

      const context = {
        tenantId: tenant,
        tenantSlug: tenantSlug(tenant),
        globalPriceListId: gSel,
        name: 'lp-sel',
        isCatalogDefault: true,
      };

      const eligibleIds = [supported, hidden, rx, variantOk, crossAllowed];
      const excludedIds = [unsupported, zeroSel, noProdPrice, crossOnly, nvp];

      // Expected deterministic order (createdAt desc), read from the DB.
      const expectedOrder = await prisma.product.findMany({
        where: { id: { in: eligibleIds } },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      expect(expectedOrder.map((p) => p.id)).toHaveLength(eligibleIds.length);

      const page1 = await repo.listPublicProducts({
        tenantId: tenant,
        context,
        filters: { sort: 'newest', page: 1, limit: 3 },
      });
      const page2 = await repo.listPublicProducts({
        tenantId: tenant,
        context,
        filters: { sort: 'newest', page: 2, limit: 3 },
      });

      // Disjoint pages covering exactly the eligible set in DB order — eligibility applied before skip/take, never after.
      expect(page1.items.map((p) => p.id)).toEqual(
        expectedOrder.slice(0, 3).map((p) => p.id),
      );
      expect(page2.items.map((p) => p.id)).toEqual(
        expectedOrder.slice(3).map((p) => p.id),
      );
      const returned = [...page1.items, ...page2.items].map((p) => p.id);
      for (const dead of excludedIds) {
        expect(returned).not.toContain(dead);
      }
      expect(returned).not.toContain(crossRescue);

      // Hidden/prescription variant-backed rows stay visible while their
      // alternate/invalid numeric arrays stay empty — direct assertions on
      // the specific variant (never a vacuous `.every()`).
      const allItems = [...page1.items, ...page2.items];
      for (const id of [hidden, rx]) {
        const row = allItems.find((p) => p.id === id)!;
        expect(row.priceLists).toEqual([]);
        expect(row.variants).toHaveLength(1);
        expect(row.variants[0].variantPrices).toEqual([]);
      }

      // Projection carries exactly the eligible selected-context cents —
      // no alternate-list or cross-tenant value leaks into any array.
      const projectedCents = allItems
        .flatMap((p) => [
          ...p.priceLists.map((pl) => pl.priceCents),
          ...p.variants.flatMap((v) =>
            v.variantPrices.map((vp) => vp.priceCents),
          ),
        ])
        .sort((a, b) => a - b);
      expect(projectedCents).toEqual([1500, 1800, 2500, 2600]);
    });

    it('honors the explicit tenantId predicate — other tenants\u2019 eligible products never leak', async () => {
      const a = (
        await seedTenant('lp-a', { isActive: true, catalogPublished: true })
      ).id;
      const b = (
        await seedTenant('lp-b', { isActive: true, catalogPublished: true })
      ).id;
      // The SAME selected list is bound to both tenants.
      const gSel = await seedGlobalPriceList('lp-both');
      await seedBinding({
        tenantId: a,
        globalPriceListId: gSel,
        isCatalogDefault: true,
      });
      await seedBinding({
        tenantId: b,
        globalPriceListId: gSel,
        isCatalogDefault: true,
      });

      currentTenantId = a;
      const aProduct = await seedProduct(a, 'a-item');
      await seedProductPrice(a, aProduct, gSel, 1000);

      currentTenantId = b;
      const bProduct = await seedProduct(b, 'b-item');
      await seedProductPrice(b, bProduct, gSel, 2000);

      currentTenantId = a;
      const result = await repo.listPublicProducts({
        tenantId: a,
        context: {
          tenantId: a,
          tenantSlug: tenantSlug(a),
          globalPriceListId: gSel,
          name: 'lp-both',
          isCatalogDefault: true,
        },
        filters: { sort: 'newest', page: 1, limit: 20 },
      });

      expect(result.items.map((p) => p.id)).toEqual([aProduct]);
      expect(result.items.map((p) => p.id)).not.toContain(bProduct);
    });
  });

  // ── F2.WU6 (slice 3) — filters, totals, excludedCount, facets ──────
  describe('F2.WU6 listPublicProducts — filters, totals, excludedCount, facets', () => {
    const ctx = (tenantId: string, globalPriceListId: string) => ({
      tenantId,
      tenantSlug: tenantSlug(tenantId),
      globalPriceListId,
      name: 'lp3',
      isCatalogDefault: true,
    });

    /** 4 eligible + 2 context-ineligible but base-matching products in two categories. */
    async function seedSlice3Matrix() {
      const tenant = (
        await seedTenant('lp3', { isActive: true, catalogPublished: true })
      ).id;
      currentTenantId = tenant;
      const gSel = await seedGlobalPriceList('lp3-sel');
      const gOther = await seedGlobalPriceList('lp3-other');
      await seedBinding({
        tenantId: tenant,
        globalPriceListId: gSel,
        isCatalogDefault: true,
      });
      const catA = await seedCategory('a');
      const catB = await seedCategory('b');
      const mk = async (
        nameTag: string,
        categoryId?: string,
        hidePrice?: boolean,
      ) => {
        const id = await seedProduct(tenant, nameTag, {
          nameTag,
          categoryId,
          hidePrice,
        });
        await seedProductPrice(tenant, id, gSel, 1000);
        return id;
      };
      // Eligible: alpha/catA, alpha/catB, beta/catA, hidden-price alpha/catB.
      const matchA1 = await mk('alpha', catA);
      const matchB1 = await mk('alpha', catB);
      const otherA = await mk('beta', catA);
      const hiddenAlpha = await mk('alpha', catB, true);
      // Ineligible but base-matching: allowlist miss (alpha/catA) and zero price (omega).
      const matchA2Excluded = await mk('alpha', catA);
      await seedAllowlistRow(tenant, matchA2Excluded, gOther);
      const omegaExcluded = await seedProduct(tenant, 'omega', {
        nameTag: 'omega',
      });
      await seedProductPrice(tenant, omegaExcluded, gSel, 0);

      return {
        tenant,
        gSel,
        catA,
        catB,
        matchA1,
        matchB1,
        otherA,
        hiddenAlpha,
        matchA2Excluded,
      };
    }

    it('computes q/category totals, aggregate excludedCount, and eligible-only facets before pagination', async () => {
      const { tenant, gSel, catA, catB, matchA1, otherA, matchA2Excluded } =
        await seedSlice3Matrix();
      const context = ctx(tenant, gSel);
      const call = (filters: {
        sort: 'newest';
        page: number;
        limit: number;
        q?: string;
        categoryId?: string;
      }) => repo.listPublicProducts({ tenantId: tenant, context, filters });

      // Unfiltered: eligible total 4 despite limit 2 (computed before
      // pagination); excludedCount = base(6) - eligible(4) = 2.
      const unfiltered = await call({ sort: 'newest', page: 1, limit: 2 });
      expect(unfiltered.total).toBe(4);
      expect(unfiltered.items).toHaveLength(2);
      expect(unfiltered.excludedCount).toBe(2);
      expect(unfiltered.items.map((p) => p.id)).not.toContain(matchA2Excluded);
      // Facets count ONLY context-eligible products under the same
      // filters; assert the exact {id,name,count} shape and name order
      // (the '-a-' label prefix sorts before '-b-' regardless of ids).
      expect(unfiltered.categories).toEqual([
        { id: catA, name: `pc-int-cat-a-${catA.slice(0, 8)}`, count: 2 },
        { id: catB, name: `pc-int-cat-b-${catB.slice(0, 8)}`, count: 2 },
      ]);

      // q 'alpha': base(4) - eligible(3) = 1. The zero-priced omega product
      // does not match q, proving the excludedCount base is filter-matching
      // (an unfiltered base would wrongly report 2 here).
      const byQ = await call({
        sort: 'newest',
        page: 1,
        limit: 20,
        q: 'alpha',
      });
      expect(byQ.total).toBe(3);
      expect(byQ.excludedCount).toBe(1);
      expect(byQ.items.map((p) => p.id)).toContain(matchA1);
      expect(byQ.items.map((p) => p.id)).not.toContain(otherA);
      expect(byQ.categories.find((f) => f.id === catA)!.count).toBe(1);

      // Category filter: catA base(3) - eligible(2) = 1.
      const byCat = await call({
        sort: 'newest',
        page: 1,
        limit: 20,
        categoryId: catA,
      });
      expect(byCat.total).toBe(2);
      expect(byCat.excludedCount).toBe(1);
      expect(byCat.items.map((p) => p.id).sort()).toEqual(
        [matchA1, otherA].sort(),
      );

      // Combined q + category.
      const combined = await call({
        sort: 'newest',
        page: 1,
        limit: 20,
        q: 'alpha',
        categoryId: catA,
      });
      expect(combined.total).toBe(1);
      expect(combined.excludedCount).toBe(1);
      expect(combined.items.map((p) => p.id)).toEqual([matchA1]);
      expect(combined.categories.map((f) => f.id)).toEqual([catA]);
      expect(combined.categories[0].count).toBe(1);
    });

    // Isolated q polarities: 'qx77' is injected into exactly one field
    // per fixture; OFF and wrong-tenant matching variants are rejected.
    it('isolates q field matching and rejects OFF/wrong-tenant matches', async () => {
      const [{ id: tenant }, { id: other }] = await Promise.all([
        seedTenant('lp3q', { isActive: true, catalogPublished: true }),
        seedTenant('lp3qo', { isActive: true, catalogPublished: true }),
      ]);
      currentTenantId = tenant;
      const gSel = await seedGlobalPriceList('lp3q-sel');
      await seedBinding({
        tenantId: tenant,
        globalPriceListId: gSel,
        isCatalogDefault: true,
      });
      const token = 'qx77';
      const brand = await prisma.brand.create({
        data: { name: `pc-int-brand-${token}-${randomUUID().slice(0, 8)}` },
      });
      const brandMatch = await seedProduct(tenant, 'zbrand');
      await seedProductPrice(tenant, brandMatch, gSel, 2500);
      await prisma.product.update({
        where: { id: brandMatch },
        data: { brandId: brand.id },
      });
      const expected = [brandMatch];
      const specs = [
        ['zvalue', true, tenant, 'INHERIT', { value: token }],
        ['zname', true, tenant, 'INHERIT', { name: `PC INT Variant ${token}` }],
        ['zoption', true, tenant, 'INHERIT', { option: token }],
        ['zcase', true, tenant, 'INHERIT', { value: 'QX77' }],
        ['zoff', false, tenant, 'OFF', { value: token }],
        ['zcross', false, other, 'INHERIT', { value: token }],
      ] as const;
      for (const [label, matches, owner, mode, fields] of specs) {
        const id = await seedProduct(tenant, label, { variants: true });
        const row = await seedProductPrice(tenant, id, gSel, 2500);
        const plain = await seedVariant(id, tenant, 'plain', 'INHERIT');
        await seedVariantPrice(tenant, plain, row, 2600);
        const probe = await seedVariant(id, owner, 'plain', mode);
        await prisma.variant.update({ where: { id: probe }, data: fields });
        if (matches) expected.push(id);
      }
      const result = await repo.listPublicProducts({
        tenantId: tenant,
        context: ctx(tenant, gSel),
        filters: { sort: 'newest', page: 1, limit: 20, q: token },
      });
      await prisma.brand.delete({ where: { id: brand.id } });
      expect(result.total).toBe(expected.length);
      expect(result.excludedCount).toBe(0);
      expect(result.items.map((p) => p.id).sort()).toEqual(
        expected.slice().sort(),
      );
    });
  });
  // ── F2.WU6 (slice 4a) — typed detail seam; throws loudly if absent.
  const detailSeam = (p: {
    tenantId: string;
    productId: string;
    context: ResolvedPublicCatalogContext;
  }): Promise<ProductDetailWithIncludes | null> => {
    const seam = repo as unknown as {
      getPublicProductDetail?: typeof detailSeam;
    };
    if (!seam.getPublicProductDetail)
      throw new Error('getPublicProductDetail seam is not implemented');
    return seam.getPublicProductDetail(p);
  };

  describe('F2.WU6 getPublicProductDetail — exact-context detail seam', () => {
    /** Tenant + selected/other lists + the full polarity matrix. */
    async function seedDetailMatrix() {
      const tenant = (
        await seedTenant('pd', { isActive: true, catalogPublished: true })
      ).id;
      const other = (
        await seedTenant('pd-x', { isActive: true, catalogPublished: true })
      ).id;
      currentTenantId = tenant;
      const gSel = await seedGlobalPriceList('pd-sel');
      const gOther = await seedGlobalPriceList('pd-other');
      await seedBinding({
        tenantId: tenant,
        globalPriceListId: gSel,
        isCatalogDefault: true,
      });
      const context: ResolvedPublicCatalogContext = {
        tenantId: tenant,
        tenantSlug: tenantSlug(tenant),
        globalPriceListId: gSel,
        name: 'pd-sel',
        isCatalogDefault: true,
      };
      const call = (productId: string, o?: { tid?: string; cid?: string }) =>
        detailSeam({
          tenantId: o?.tid ?? tenant,
          productId,
          context: o?.cid ? { ...context, tenantId: o.cid } : context,
        });
      const withVariant = async (
        label: string,
        popts: Parameters<typeof seedProduct>[2],
      ) => {
        const id = await seedProduct(tenant, label, popts);
        const variant = await seedVariant(id, tenant, `v-${label}`, 'INHERIT');
        return { id, variant };
      };

      const simple = await seedProduct(tenant, 'simple');
      await seedProductPrice(tenant, simple, gSel, 1500);
      await seedProductPrice(tenant, simple, gOther, 9999);
      // Wrong-tenant allowlist row only → zero same-tenant rows.
      const supportAll = await seedProduct(tenant, 'support-all');
      await seedProductPrice(tenant, supportAll, gSel, 1800);
      await seedAllowlistRow(other, supportAll, gOther);
      // Same-tenant allowlist rows miss the selected list; a wrong-tenant
      // selected-list row must never rescue the mismatch.
      const mismatch = await seedProduct(tenant, 'mismatch');
      await seedProductPrice(tenant, mismatch, gSel, 1600);
      await seedAllowlistRow(tenant, mismatch, gOther);
      await seedAllowlistRow(other, mismatch, gSel);
      // Only an alternate positive price row.
      const noSel = await seedProduct(tenant, 'no-sel');
      await seedProductPrice(tenant, noSel, gOther, 8888);
      // Zero selected price; alternate positive never rescues.
      const zeroSel = await seedProduct(tenant, 'zero-sel');
      await seedProductPrice(tenant, zeroSel, gSel, 0);
      await seedProductPrice(tenant, zeroSel, gOther, 7777);
      // Variant BOTH positive; sibling variants priced zero/alt-only/unpriced
      // and wrong-tenant rows must be omitted, never rescue or leak.
      const variantOk = await withVariant('variant-ok', { variants: true });
      const okRow = await seedProductPrice(tenant, variantOk.id, gSel, 2500);
      const okAlt = await seedProductPrice(tenant, variantOk.id, gOther, 2700);
      await seedVariantPrice(tenant, variantOk.variant, okRow, 2600);
      const okZero = await seedVariant(variantOk.id, tenant, 'v-zero', 'ON');
      await seedVariantPrice(tenant, okZero, okRow, 0);
      const okAltV = await seedVariant(variantOk.id, tenant, 'v-alt', 'ON');
      await seedVariantPrice(tenant, okAltV, okAlt, 2800);
      await seedVariant(variantOk.id, tenant, 'v-un', 'ON');
      const vX = await seedVariant(variantOk.id, other, 'v-x', 'ON');
      await seedVariantPrice(tenant, vX, okRow, 2950);
      await seedVariantPrice(other, okZero, okRow, 2900);
      // BOTH product-side fail: zero selected product, positive variant.
      const prodZero = await withVariant('prod-zero', { variants: true });
      const pzRow = await seedProductPrice(tenant, prodZero.id, gSel, 0);
      await seedProductPrice(tenant, prodZero.id, gOther, 6666);
      await seedVariantPrice(tenant, prodZero.variant, pzRow, 5000);
      // BOTH variant-side fail: positive product, zero selected variant.
      const varZero = await withVariant('var-zero', { variants: true });
      const vzRow = await seedProductPrice(tenant, varZero.id, gSel, 3000);
      const vzAlt = await seedProductPrice(tenant, varZero.id, gOther, 5555);
      await seedVariantPrice(tenant, varZero.variant, vzRow, 0);
      await seedVariantPrice(tenant, varZero.variant, vzAlt, 5100);
      // Wrong-tenant variant prices (selected + nested cross-tenant list row)
      // must never rescue the failed variant BOTH gate.
      await seedVariantPrice(other, varZero.variant, vzRow, 5101);
      const vw = await seedVariant(varZero.id, other, 'v-w', 'ON');
      await seedVariantPrice(tenant, vw, vzRow, 5103);
      // Hidden: selected positive rows exist but must stay redacted.
      const hidden = await withVariant('hidden', {
        variants: true,
        hidePrice: true,
      });
      const hRow = await seedProductPrice(tenant, hidden.id, gSel, 4100);
      await seedVariantPrice(tenant, hidden.variant, hRow, 4200);
      await seedAllowlistRow(tenant, hidden.id, gOther);
      // Prescription: selected positive rows exist but must stay redacted.
      const rx = await withVariant('rx', {
        variants: true,
        requiresPrescription: true,
      });
      const rxRow = await seedProductPrice(tenant, rx.id, gSel, 4300);
      await seedVariantPrice(tenant, rx.variant, rxRow, 4400);
      await seedAllowlistRow(tenant, rx.id, gOther);
      // All-OFF hidden: survivorship is never bypassed.
      const hiddenAllOff = await seedProduct(tenant, 'hidden-off', {
        variants: true,
        hidePrice: true,
      });
      await seedVariant(hiddenAllOff, tenant, 'voff1', 'OFF');
      await seedVariant(hiddenAllOff, tenant, 'voff2', 'OFF');
      // Generic-miss fixtures: excluded, SERVICE, cross-tenant eligible.
      const excluded = await seedProduct(tenant, 'excluded', {
        include: false,
      });
      await seedProductPrice(tenant, excluded, gSel, 1900);
      const service = await seedProduct(tenant, 'service', {
        type: 'SERVICE',
      });
      await seedProductPrice(tenant, service, gSel, 1100);
      const otherEligible = await seedProduct(other, 'other-elig');
      const oeRow = await seedProductPrice(other, otherEligible, gSel, 1200);
      // Nested cross-tenant price-list row: tenant-owned variant price whose
      // list belongs to another tenant must not rescue either.
      await seedVariantPrice(tenant, varZero.variant, oeRow, 5102);
      return {
        other,
        call,
        simple,
        supportAll,
        mismatch,
        noSel,
        zeroSel,
        variantOk: variantOk.id,
        okV: variantOk.variant,
        prodZero: prodZero.id,
        varZero: varZero.id,
        hidden: hidden.id,
        hV: hidden.variant,
        rx: rx.id,
        hiddenAllOff,
        excluded,
        service,
        otherEligible,
      };
    }

    it('returns exact-context detail for eligible products and projects only selected positive prices', async () => {
      const m = await seedDetailMatrix();

      const simpleDetail = await m.call(m.simple);
      expect(simpleDetail).not.toBeNull();
      expect(simpleDetail!.id).toBe(m.simple);
      expect(simpleDetail!.priceLists).toEqual([{ priceCents: 1500 }]);

      const supportAllDetail = await m.call(m.supportAll);
      expect(supportAllDetail).not.toBeNull();
      expect(supportAllDetail!.priceLists).toEqual([{ priceCents: 1800 }]);

      const variantDetail = await m.call(m.variantOk);
      expect(variantDetail).not.toBeNull();
      expect(variantDetail!.variants).toHaveLength(1);
      expect(variantDetail!.variants[0].id).toBe(m.okV);
      expect(variantDetail!.variants[0].variantPrices).toEqual([
        { priceCents: 2600 },
      ]);

      // Exact shape: the alternate 2700 product row never projects.
      expect(variantDetail!.priceLists).toEqual([{ priceCents: 2500 }]);
    });

    it('returns the generic null for every excluded detail reason', async () => {
      const m = await seedDetailMatrix();
      // Allowlist mismatch; missing/zero selected price; failed variant
      // BOTH (either side); all-OFF hidden; excluded; SERVICE.
      for (const dead of [
        m.mismatch,
        m.noSel,
        m.zeroSel,
        m.prodZero,
        m.varZero,
        m.hiddenAllOff,
        m.excluded,
        m.service,
      ]) {
        await expect(m.call(dead)).resolves.toBeNull();
      }
      // Missing id; cross-tenant product under the correct context;
      // param/context tenant mismatch (even for an eligible product).
      await expect(m.call(randomUUID())).resolves.toBeNull();
      await expect(m.call(m.otherEligible)).resolves.toBeNull();
      await expect(m.call(m.simple, { cid: m.other })).resolves.toBeNull();
    });

    it('hidden/prescription bypass allowlist and price eligibility but expose no numeric rows', async () => {
      const m = await seedDetailMatrix();

      const hiddenDetail = await m.call(m.hidden);
      expect(hiddenDetail).not.toBeNull();
      expect(hiddenDetail!.priceLists).toEqual([]);
      expect(hiddenDetail!.variants).toHaveLength(1);
      expect(hiddenDetail!.variants[0].id).toBe(m.hV);
      expect(hiddenDetail!.variants[0].variantPrices).toEqual([]);

      const rxDetail = await m.call(m.rx);
      expect(rxDetail).not.toBeNull();
      expect(rxDetail!.priceLists).toEqual([]);
      expect(rxDetail!.variants[0].variantPrices).toEqual([]);
    });
  });

  // ── F2.WU6 (evidence correction) — two independent tenant contexts ────
  // One tenant bound to TWO distinct public global lists (default +
  // explicit non-default); each list is resolved and selected
  // independently as a tenant context, and each list/detail seam must
  // project ONLY its own distinct positive prices with no cross-list
  // substitution, default fallback, or leakage between contexts.
  describe('F2.WU6 two-context consistency — default + explicit non-default per tenant', () => {
    it('resolves two distinct tenant contexts and each list/detail seam projects only its own distinct prices', async () => {
      const tenant = (
        await seedTenant('two-ctx', {
          isActive: true,
          catalogPublished: true,
        })
      ).id;
      currentTenantId = tenant;

      // One tenant, two DISTINCT public global lists: catalog default
      // plus an explicit non-default binding.
      const gDefault = await seedGlobalPriceList('two-ctx-default');
      const gExplicit = await seedGlobalPriceList('two-ctx-explicit');
      await seedBinding({
        tenantId: tenant,
        globalPriceListId: gDefault,
        isCatalogDefault: true,
      });
      await seedBinding({
        tenantId: tenant,
        globalPriceListId: gExplicit,
        isCatalogDefault: false,
      });

      // Resolve each context independently as a real tenant context —
      // the explicit list is a tenant-bound selection, not an unbound
      // fallback/allowlist lure.
      const ctxDefault = await repo.resolveTenantCatalogContext?.(
        tenantSlug(tenant),
      );
      const ctxExplicit = await repo.resolveTenantCatalogContext?.(
        tenantSlug(tenant),
        gExplicit,
      );
      expect(ctxDefault).toMatchObject({
        tenantId: tenant,
        tenantSlug: tenantSlug(tenant),
        globalPriceListId: gDefault,
        isCatalogDefault: true,
      });
      expect(ctxExplicit).toMatchObject({
        tenantId: tenant,
        tenantSlug: tenantSlug(tenant),
        globalPriceListId: gExplicit,
        isCatalogDefault: false,
      });
      expect(ctxDefault!.globalPriceListId).not.toBe(
        ctxExplicit!.globalPriceListId,
      );

      // One eligible visible-price product priced in BOTH lists with
      // distinct amounts, plus a variant-backed sibling with distinct
      // selected-list prices per list as well.
      const plain = await seedProduct(tenant, 'two-ctx-plain');
      await seedProductPrice(tenant, plain, gDefault, 1100);
      await seedProductPrice(tenant, plain, gExplicit, 2200);

      const withVariant = await seedProduct(tenant, 'two-ctx-variant', {
        variants: true,
      });
      const defRow = await seedProductPrice(
        tenant,
        withVariant,
        gDefault,
        1200,
      );
      const expRow = await seedProductPrice(
        tenant,
        withVariant,
        gExplicit,
        2300,
      );
      const variant = await seedVariant(withVariant, tenant, 'v2c', 'INHERIT');
      await seedVariantPrice(tenant, variant, defRow, 1300);
      await seedVariantPrice(tenant, variant, expRow, 2400);

      const expectedIds = [plain, withVariant];
      const listFor = async (ctx: ResolvedPublicCatalogContext) => {
        const result = await repo.listPublicProducts({
          tenantId: tenant,
          context: ctx,
          filters: { sort: 'newest', page: 1, limit: 20 },
        });
        expect(result.total).toBe(2);
        expect(result.excludedCount).toBe(0);
        expect(result.items.map((p) => p.id).sort()).toEqual(
          expectedIds.slice().sort(),
        );
        return result;
      };

      // Context A (default): only default-list amounts project.
      const listA = await listFor(ctxDefault!);
      expect(listA.items.find((p) => p.id === plain)!.priceLists).toEqual([
        { priceCents: 1100 },
      ]);
      const varA = listA.items.find((p) => p.id === withVariant)!;
      expect(varA.variants).toHaveLength(1);
      expect(varA.variants[0].variantPrices).toEqual([{ priceCents: 1300 }]);

      // Context B (explicit non-default): only explicit-list amounts
      // project — no default-list substitution anywhere.
      const listB = await listFor(ctxExplicit!);
      expect(listB.items.find((p) => p.id === plain)!.priceLists).toEqual([
        { priceCents: 2200 },
      ]);
      const varB = listB.items.find((p) => p.id === withVariant)!;
      expect(varB.variants).toHaveLength(1);
      expect(varB.variants[0].variantPrices).toEqual([{ priceCents: 2400 }]);

      // Detail seams stay independent too: each context resolves the
      // same products at its own distinct amounts.
      const detailAPlain = await detailSeam({
        tenantId: tenant,
        productId: plain,
        context: ctxDefault!,
      });
      expect(detailAPlain).not.toBeNull();
      expect(detailAPlain!.priceLists).toEqual([{ priceCents: 1100 }]);
      const detailAVar = await detailSeam({
        tenantId: tenant,
        productId: withVariant,
        context: ctxDefault!,
      });
      expect(detailAVar).not.toBeNull();
      expect(detailAVar!.priceLists).toEqual([{ priceCents: 1200 }]);
      expect(detailAVar!.variants[0].variantPrices).toEqual([
        { priceCents: 1300 },
      ]);

      const detailBPlain = await detailSeam({
        tenantId: tenant,
        productId: plain,
        context: ctxExplicit!,
      });
      expect(detailBPlain).not.toBeNull();
      expect(detailBPlain!.priceLists).toEqual([{ priceCents: 2200 }]);
      const detailBVar = await detailSeam({
        tenantId: tenant,
        productId: withVariant,
        context: ctxExplicit!,
      });
      expect(detailBVar).not.toBeNull();
      expect(detailBVar!.priceLists).toEqual([{ priceCents: 2300 }]);
      expect(detailBVar!.variants[0].variantPrices).toEqual([
        { priceCents: 2400 },
      ]);
    });
  });

  // ── F2.WU7 slice 3 — cart projection + reconciliation: real-DB proof via the retained bulk-load seam.
  describe('F2.WU7 slice 3 — findPublicCartCandidates + executeForContext', () => {
    async function seedCartMatrix() {
      const pub = (label: string) =>
        seedTenant(label, { isActive: true, catalogPublished: true });
      const tenant = (await pub('cart')).id;
      const other = (await pub('cart-x')).id;
      currentTenantId = tenant;
      const gSel = await seedGlobalPriceList('cart-sel');
      const gDefault = await seedGlobalPriceList('cart-def');
      await seedBinding({
        tenantId: tenant,
        globalPriceListId: gDefault,
        isCatalogDefault: true,
      });
      const context: ResolvedPublicCatalogContext = {
        tenantId: tenant,
        tenantSlug: tenantSlug(tenant),
        globalPriceListId: gSel,
        name: 'cart-sel',
        isCatalogDefault: false,
      };

      const eligible = await seedProduct(tenant, 'eligible', {
        variants: true,
        quantity: 50,
      });
      const elRow = await seedProductPrice(tenant, eligible, gSel, 1500);
      const elVar = await seedVariant(eligible, tenant, 'on', 'ON', {
        quantity: 50,
      });
      await seedVariantPrice(tenant, elVar, elRow, 1600);
      const elOff = await seedVariant(eligible, tenant, 'off', 'OFF');
      const allowMiss = await seedProduct(tenant, 'allow-miss', {
        quantity: 50,
      });
      await seedProductPrice(tenant, allowMiss, gSel, 1700);
      await seedAllowlistRow(tenant, allowMiss, gDefault);
      // Priced only in the catalog-default list: the default binding must never rescue a non-default selected context.
      const defOnly = await seedProduct(tenant, 'default-only', {
        quantity: 50,
      });
      await seedProductPrice(tenant, defOnly, gDefault, 1800);
      const zeroSel = await seedProduct(tenant, 'zero-sel', { quantity: 50 });
      await seedProductPrice(tenant, zeroSel, gSel, 0);
      await seedProductPrice(tenant, zeroSel, gDefault, 5555);
      const excluded = await seedProduct(tenant, 'excluded', {
        include: false,
      });
      await seedProductPrice(tenant, excluded, gSel, 1900);
      const service = await seedProduct(tenant, 'service', { type: 'SERVICE' });
      const hidden = await seedProduct(tenant, 'hidden', {
        hidePrice: true,
        quantity: 50,
      });
      await seedProductPrice(tenant, hidden, gSel, 2000);
      const oos = await seedProduct(tenant, 'oos', { quantity: 0 });
      await seedProductPrice(tenant, oos, gSel, 2100);
      // Cross-tenant eligible product sharing the selected list ID.
      const foreign = await seedProduct(other, 'foreign');
      await seedProductPrice(other, foreign, gSel, 2200);

      return {
        tenant,
        other,
        gSel,
        gDefault,
        context,
        eligible,
        elVar,
        elOff,
        allowMiss,
        defOnly,
        zeroSel,
        excluded,
        service,
        hidden,
        oos,
        foreign,
      };
    }

    it('projects retained-for-classification candidates with exact-context prices, requested variants, and tenant isolation', async () => {
      const m = await seedCartMatrix();
      if (!repo.findPublicCartCandidates)
        throw new Error('findPublicCartCandidates seam is not implemented');

      // Duplicate requested IDs arrive de-duplicated in the projection.
      const candidates = await repo.findPublicCartCandidates({
        tenantId: m.tenant,
        context: m.context,
        productIds: [
          m.eligible,
          m.eligible,
          m.allowMiss,
          m.defOnly,
          m.zeroSel,
          m.excluded,
          m.service,
          m.hidden,
          m.oos,
          m.foreign,
        ],
        variantIds: [m.elVar, m.elVar, m.elOff],
      });
      const byId = new Map(candidates.map((c) => [c.id, c]));

      // One row per unique tenant product; the cross-tenant product never projects even though requested and priced on the selected list.
      expect(candidates).toHaveLength(8);

      // Excluded/SERVICE parents and requested OFF variants are retained for application classification (never filtered in the adapter).
      expect(byId.get(m.excluded)!.includeInOnlineCatalog).toBe(false);
      expect(byId.get(m.service)!.type).toBe('SERVICE');
      const eligible = byId.get(m.eligible)!;
      expect(eligible.variants.map((v) => v.id)).toEqual([m.elVar, m.elOff]);
      expect(eligible.variants[0].variantPrices).toEqual([
        { priceCents: 1600 },
      ]);
      expect(eligible.variants[1].variantPrices).toEqual([]);
      expect(eligible.priceLists).toEqual([{ priceCents: 1500 }]);

      // Same-tenant allowlist rows project; prices are exact selected-context positive only (default-only/zero rows never project).
      expect(byId.get(m.allowMiss)!.catalogPriceLists).toEqual([
        { globalPriceListId: m.gDefault },
      ]);
      expect(byId.get(m.allowMiss)!.priceLists).toEqual([{ priceCents: 1700 }]);
      expect(byId.get(m.defOnly)!.priceLists).toEqual([]);
      expect(byId.get(m.zeroSel)!.priceLists).toEqual([]);

      // Tenant/context param mismatch: no candidates, no query error.
      await expect(
        repo.findPublicCartCandidates({
          tenantId: m.other,
          context: m.context,
          productIds: [m.eligible],
          variantIds: [],
        }),
      ).resolves.toEqual([]);
    });

    it('reconciles a mixed real-DB cart with no default fallback, uniform redaction, OOS total retention, and idempotence', async () => {
      const m = await seedCartMatrix();
      const items = [
        { productId: m.eligible, quantity: 2 },
        { productId: m.eligible, variantId: m.elVar, quantity: 1 },
        { productId: m.eligible, variantId: m.elOff, quantity: 1 },
        { productId: m.defOnly, quantity: 1 },
        { productId: m.zeroSel, quantity: 1 },
        { productId: m.excluded, quantity: 1 },
        { productId: m.service, quantity: 1 },
        { productId: m.eligible, variantId: randomUUID(), quantity: 1 },
        { productId: m.hidden, quantity: 1 },
        { productId: m.oos, quantity: 2 },
        { productId: m.foreign, quantity: 1 },
      ];
      const reconcile = (its: typeof items) =>
        useCase.executeForContext({
          tenant: { id: m.tenant, slug: tenantSlug(m.tenant) },
          context: m.context,
          items: its,
        });
      const result = await reconcile(items);

      expect(result.priceContext).toEqual({
        priceListId: m.gSel,
        name: 'cart-sel',
        isCatalogDefault: false,
      });
      expect(result.items.map((i) => i.blockingCodes)).toEqual([
        [],
        [],
        ['VARIANT_NOT_IN_CATALOG'],
        ['PRICE_NOT_AVAILABLE_IN_CONTEXT'],
        ['PRICE_NOT_AVAILABLE_IN_CONTEXT'],
        ['NOT_IN_CATALOG'],
        ['NOT_IN_CATALOG'],
        ['VARIANT_NOT_FOUND'],
        [],
        ['OUT_OF_STOCK'],
        ['NOT_IN_CATALOG'],
      ]);

      const rows = result.items; // [0] plain, [1] ON variant, [2] OFF, [7] missing variant, [8] hidden, [9] OOS, [10] foreign
      expect(rows[0].unitPriceCents).toBe(1500);
      expect(rows[0].lineTotalCents).toBe(3000);
      expect(rows[1].unitPriceCents).toBe(1600);
      // Redacted misses disclose nothing.
      for (const row of [rows[2], rows[7], rows[10]]) {
        expect(row.productName).toBeNull();
        expect(row.variantName).toBeNull();
        expect(row.image).toBeNull();
      }
      // Hidden/prescription precedence: no blocking, null numerics.
      expect(rows[8].warnings).toEqual(['PRICE_HIDDEN']);
      expect(rows[8].unitPriceCents).toBeNull();
      // Visible OOS keeps its authoritative line total but is excluded from the aggregate (3000 + 1600 only).
      expect(rows[9].lineTotalCents).toBe(4200);
      // Any hidden line nulls the aggregate entirely.
      expect(result.totalCents).toBeNull();

      // No hidden line: numeric aggregate, still excluding the OOS row.
      const noHidden = await reconcile(
        items.filter((it) => it.productId !== m.hidden),
      );
      expect(noHidden.totalCents).toBe(4600);
      // Repeat reconciliation is byte-identical: no persistence side effects.
      expect(await reconcile(items)).toEqual(result);
    });
  });
});
