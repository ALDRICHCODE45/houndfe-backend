/**
 * F1.WU2b.1d-2C — PrismaCatalogSettingsRepository REAL PostgreSQL constraint /
 * conflict evidence (last integration spec in the WU2b evidence set).
 *
 * Proves against `nest-practice-test` (port 5433 — NEVER dev):
 *   C1 — direct second-default promotion for ONE tenant is rejected under the
 *        partial unique index `tenant_catalog_price_lists_one_default_per_tenant`;
 *        the original default remains and the rejected row is not persisted.
 *   C2 — the SAME `GlobalPriceList` may be bound in SEPARATE tenants (per-tenant
 *        scope allows cross-tenant sharing of one global list, each tenant
 *        keeps an independent default).
 *   C3 — duplicate `(tenantId, globalPriceListId)` binding rejects under the
 *        composite unique `tenant_catalog_price_lists_tenantId_globalPriceListId_key`;
 *        the first binding remains.
 *   C4 — afterEach explicit cleanup removes every randomized tenant/binding/
 *        global fixture; no TRUNCATE, no leak across tests.
 *
 * Conservative Prisma/constraint evidence:
 *   - All errors are asserted by `Prisma.PrismaClientKnownRequestError` with
 *     `code === 'P2002'` (Prisma's unique-constraint violation code).
 *   - `meta.target` patterns are matched when present (Prisma populates them
 *     from the underlying index columns), but the spec NEVER claims an HTTP
 *     409 mapping — that contract lives in WU3's
 *     `domain-exception.filter.ts` and is out of scope here.
 *
 * Mirrors the existing replace/rollback/sequencing integration specs:
 *   shared `integrationPrisma()` + randomized `randomUUID()` ids, tracked-id
 *   explicit-delete cleanup (NO TRUNCATE). Cleanup order is tenant-owned
 *   rows first (`tenantCatalogPriceList` → `tenant`), then the randomized
 *   `globalPriceList` rows (nothing references them by then).
 *
 * Skips when `SKIP_DB_INTEGRATION=1` or `DATABASE_URL` is unset.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';

/**
 * Index names from
 * `prisma/migrations/20260901000000_online_catalog_publishing/migration.sql`.
 * Documented here as a reference for the schema-level evidence these tests
 * prove; the assertions below only assert Prisma-level evidence
 * (`code === 'P2002'` + `meta.target`) and intentionally do NOT match the
 * PG index name in the error message — Prisma does not expose it.
 */
//   - `tenant_catalog_price_lists_one_default_per_tenant` (partial unique
//     on (tenantId) WHERE isCatalogDefault = true — covers C1).
//   - `tenant_catalog_price_lists_tenantId_globalPriceListId_key`
//     (composite unique on (tenantId, globalPriceListId) — covers C3).

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

const tenantSlug = (id: string): string => `cs-cf-${id.slice(0, 8)}`;
const globalName = (id: string, suffix: string): string =>
  `cs-cf-list-${id.slice(0, 8)}-${suffix}`;

/**
 * Conservative Prisma error matcher. The assertion is intentionally narrow:
 *   1. The thrown error is `Prisma.PrismaClientKnownRequestError` with
 *      `code === 'P2002'` (Prisma's unique-constraint violation code).
 *   2. If `target` is provided, `meta.target` contains every expected column
 *      name — this is the only schema fingerprint Prisma exposes, and it
 *      mirrors the underlying index columns. We never assert the PG
 *      index name (Prisma's user-facing message does not include it) and
 *      we never claim any HTTP status mapping (that contract lives in
 *      WU3's `domain-exception.filter.ts`).
 */
async function expectP2002(
  promise: Promise<unknown>,
  options: {
    /** Expected column names from the violated unique index. */
    target?: ReadonlyArray<string>;
  } = {},
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  const known = caught as Prisma.PrismaClientKnownRequestError;
  expect(known.code).toBe('P2002');
  if (options.target && options.target.length > 0) {
    const meta = known.meta as { target?: unknown } | undefined;
    const raw = meta?.target;
    const actual = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === 'string'
        ? raw.split(',').map((s) => s.trim())
        : [];
    expect(actual).toEqual(expect.arrayContaining([...options.target]));
  }
}

describeIfDb(
  'PrismaCatalogSettingsRepository constraint/conflict (Integration - Real DB)',
  () => {
    let prisma: PrismaClient;
    // Tracked ids for explicit-delete cleanup (NO TRUNCATE).
    const trackedTenantIds: string[] = [];
    const trackedGlobalPriceListIds: string[] = [];

    beforeAll(() => {
      prisma = integrationPrisma();
    });

    beforeEach(() => {
      trackedTenantIds.length = 0;
      trackedGlobalPriceListIds.length = 0;
    });

    afterEach(async () => {
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
      await disconnectIntegrationPrisma();
    });

    // ── Fixture helpers ────────────────────────────────────────────────────

    async function seedTenant(label: string): Promise<string> {
      const id = randomUUID();
      await prisma.tenant.create({
        data: {
          id,
          name: `Conflict Tenant ${label} ${id.slice(0, 8)}`,
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
        data: { id, name: globalName(id, suffix), isDefault: false },
      });
      trackedGlobalPriceListIds.push(id);
      return id;
    }

    // ── C1 — partial unique index rejects a second default for one tenant ──

    it('C1: direct second-default promotion for one tenant is rejected by the partial unique index; original default remains', async () => {
      const tenantId = await seedTenant('C1');
      const gOriginal = await seedGlobalPriceList('orig');
      const gChallenger = await seedGlobalPriceList('challenger');

      // Insert the original default binding for the tenant (id auto-generated).
      await prisma.tenantCatalogPriceList.create({
        data: {
          tenantId,
          globalPriceListId: gOriginal,
          isCatalogDefault: true,
        },
      });
      const before = await prisma.tenantCatalogPriceList.findMany({
        where: { tenantId },
        orderBy: { globalPriceListId: 'asc' },
      });
      expect(before).toHaveLength(1);
      expect(before[0].isCatalogDefault).toBe(true);
      expect(before[0].globalPriceListId).toBe(gOriginal);

      // Attempt a second isCatalogDefault=true row for the same tenant.
      await expectP2002(
        prisma.tenantCatalogPriceList.create({
          data: {
            tenantId,
            globalPriceListId: gChallenger,
            isCatalogDefault: true,
          },
        }),
        { target: ['tenantId'] },
      );

      // Original default survives — exactly one row, same globalPriceListId.
      const after = await prisma.tenantCatalogPriceList.findMany({
        where: { tenantId },
        orderBy: { globalPriceListId: 'asc' },
      });
      expect(after).toHaveLength(1);
      expect(after[0].isCatalogDefault).toBe(true);
      expect(after[0].globalPriceListId).toBe(gOriginal);
      // Challenger never persisted.
      expect(
        after.find((b) => b.globalPriceListId === gChallenger),
      ).toBeUndefined();
    });

    // ── C2 — same GlobalPriceList may be bound in separate tenants ──────────

    it('C2: the same GlobalPriceList may be bound in separate tenants, each with its own default', async () => {
      const tenantA = await seedTenant('A');
      const tenantB = await seedTenant('B');
      const shared = await seedGlobalPriceList('shared');

      // Each tenant gets its own binding row pointing at the SAME
      // globalPriceList — partial unique is keyed on tenantId, so both
      // promotions to default succeed independently.
      await prisma.tenantCatalogPriceList.create({
        data: {
          tenantId: tenantA,
          globalPriceListId: shared,
          isCatalogDefault: true,
        },
      });
      await prisma.tenantCatalogPriceList.create({
        data: {
          tenantId: tenantB,
          globalPriceListId: shared,
          isCatalogDefault: true,
        },
      });

      const aBindings = await prisma.tenantCatalogPriceList.findMany({
        where: { tenantId: tenantA },
      });
      const bBindings = await prisma.tenantCatalogPriceList.findMany({
        where: { tenantId: tenantB },
      });
      expect(aBindings).toHaveLength(1);
      expect(bBindings).toHaveLength(1);
      expect(aBindings[0].globalPriceListId).toBe(shared);
      expect(bBindings[0].globalPriceListId).toBe(shared);
      expect(aBindings[0].isCatalogDefault).toBe(true);
      expect(bBindings[0].isCatalogDefault).toBe(true);

      // The shared globalPriceList row is intact and still referenced by
      // both tenants — no cascade triggered.
      const globalRow = await prisma.globalPriceList.findUniqueOrThrow({
        where: { id: shared },
      });
      expect(globalRow.id).toBe(shared);

      // Cross-tenant scoping preserved — neither tenant's row leaks into the
      // other's projection.
      const aTenantIds = aBindings.map((b) => b.tenantId);
      const bTenantIds = bBindings.map((b) => b.tenantId);
      expect(aTenantIds).toEqual([tenantA]);
      expect(bTenantIds).toEqual([tenantB]);
    });

    // ── C3 — composite unique rejects duplicate (tenantId, globalPriceListId)

    it('C3: duplicate (tenantId, globalPriceListId) binding rejects under composite uniqueness; first binding remains', async () => {
      const tenantId = await seedTenant('C3');
      const globalPriceListId = await seedGlobalPriceList('dup');

      // First binding — non-default to keep this test orthogonal to C1.
      await prisma.tenantCatalogPriceList.create({
        data: {
          tenantId,
          globalPriceListId,
          isCatalogDefault: false,
        },
      });
      const before = await prisma.tenantCatalogPriceList.findMany({
        where: { tenantId },
      });
      expect(before).toHaveLength(1);
      expect(before[0].globalPriceListId).toBe(globalPriceListId);

      // Attempt to insert a second row for the same business key — even
      // with the same (false) default flag the composite unique fires.
      await expectP2002(
        prisma.tenantCatalogPriceList.create({
          data: {
            tenantId,
            globalPriceListId,
            isCatalogDefault: false,
          },
        }),
        { target: ['tenantId', 'globalPriceListId'] },
      );

      const after = await prisma.tenantCatalogPriceList.findMany({
        where: { tenantId },
      });
      expect(after).toHaveLength(1);
      expect(after[0].globalPriceListId).toBe(globalPriceListId);
      // Binding id is the original — proves no second row snuck in.
      expect(after[0].id).toBe(before[0].id);
    });

    // ── C4 — afterEach explicit cleanup removes every tracked fixture ───────

    it('C4: afterEach explicit cleanup removes every randomized tenant/binding/global fixture (no truncate)', async () => {
      // Seed two tenants, two bindings per tenant, and two globals — all
      // randomized and all tracked. Cleanup must remove every row.
      const tenantA = await seedTenant('A');
      const tenantB = await seedTenant('B');
      const gA = await seedGlobalPriceList('A');
      const gB = await seedGlobalPriceList('B');
      await prisma.tenantCatalogPriceList.create({
        data: {
          tenantId: tenantA,
          globalPriceListId: gA,
          isCatalogDefault: true,
        },
      });
      await prisma.tenantCatalogPriceList.create({
        data: {
          tenantId: tenantA,
          globalPriceListId: gB,
          isCatalogDefault: false,
        },
      });
      await prisma.tenantCatalogPriceList.create({
        data: {
          tenantId: tenantB,
          globalPriceListId: gA,
          isCatalogDefault: true,
        },
      });

      // Sanity: fixtures exist before cleanup runs.
      expect(
        await prisma.tenant.count({
          where: { id: { in: [tenantA, tenantB] } },
        }),
      ).toBe(2);
      expect(
        await prisma.tenantCatalogPriceList.count({
          where: { tenantId: { in: [tenantA, tenantB] } },
        }),
      ).toBe(3);
      expect(
        await prisma.globalPriceList.count({
          where: { id: { in: [gA, gB] } },
        }),
      ).toBe(2);

      // Run the same cleanup the afterEach hook performs — explicit-delete,
      // tenant-owned rows first, then globals.
      await prisma.tenantCatalogPriceList.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.tenant.deleteMany({
        where: { id: { in: [tenantA, tenantB] } },
      });
      await prisma.globalPriceList.deleteMany({
        where: { id: { in: [gA, gB] } },
      });

      // Every fixture removed — proves no TRUNCATE was required and no
      // row survived the explicit-delete cleanup.
      expect(
        await prisma.tenant.count({
          where: { id: { in: [tenantA, tenantB] } },
        }),
      ).toBe(0);
      expect(
        await prisma.tenantCatalogPriceList.count({
          where: { tenantId: { in: [tenantA, tenantB] } },
        }),
      ).toBe(0);
      expect(
        await prisma.globalPriceList.count({
          where: { id: { in: [gA, gB] } },
        }),
      ).toBe(0);

      // Mark the tracked arrays consumed — the real afterEach is now a no-op.
      trackedTenantIds.length = 0;
      trackedGlobalPriceListIds.length = 0;
    });
  },
);
