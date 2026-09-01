/**
 * F1.WU2b.1d-2A — real PostgreSQL replacement-success evidence for
 * PrismaCatalogSettingsRepository.replace, against `nest-practice-test`
 * (port 5433 — NEVER dev).
 *
 * Coverage:
 *   T1 — replacement atomically changes bindings PLUS tenant publication
 *        flag + stock-presentation mode + custom quantity in one commit.
 *   T2 — repeated identical replacement remains one row per binding and
 *        exactly one row with `isCatalogDefault = true`.
 *   T3 — stale bindings removed; requested bindings retained.
 *   T4 — returned aggregate (post-replace) equals a fresh
 *        `findByTenantId` projection of the committed state.
 *
 * Mirrors `prisma-catalog-settings.repository.integration.spec.ts`:
 * shared `integrationPrisma()` + CLS shim, randomized `randomUUID()` ids,
 * tracked-id explicit-delete cleanup (NO TRUNCATE). Cleanup order:
 * TenantCatalogPriceList → Tenant → GlobalPriceList.
 *
 * Skips when `SKIP_DB_INTEGRATION=1` or `DATABASE_URL` is unset.
 */
import { randomUUID } from 'node:crypto';
import type { ClsService } from 'nestjs-cls';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { TenantCatalogSettings } from '../domain/tenant-catalog-settings.aggregate';
import {
  TenantCatalogPriceListBinding,
  type TenantCatalogPriceListBindingProps,
} from '../domain/tenant-catalog-price-list.entity';
import { PrismaCatalogSettingsRepository } from './prisma-catalog-settings.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

const tenantSlug = (id: string): string => `cs-rep-${id.slice(0, 8)}`;
const globalName = (id: string, suffix: string): string =>
  `cs-rep-list-${id.slice(0, 8)}-${suffix}`;
type StockMode =
  | 'SYSTEM_STATUS'
  | 'ABSTRACT_STATUS'
  | 'CUSTOM_QUANTITY'
  | 'HIDDEN';

describeIfDb(
  'PrismaCatalogSettingsRepository.replace (Integration - Real DB)',
  () => {
    let repo: PrismaCatalogSettingsRepository;
    /** Mutable CLS tenant — tests set this so `getClient()` resolves. */
    let currentTenantId: string;
    // Tracked ids for explicit-delete cleanup (NO TRUNCATE).
    const trackedTenantIds: string[] = [];
    const trackedGlobalPriceListIds: string[] = [];

    beforeAll(() => {
      const prisma = integrationPrisma();
      const cls = {
        get: (key: string) => {
          if (key === 'tenantId') return currentTenantId;
          if (key === 'isSuperAdmin') return false;
          return undefined;
        },
        // `replace` calls `runInTransaction` which `cls.set`s the tx
        // client slot; no-op is fine — every test runs the full flow inline.
        set: () => undefined,
      } as unknown as ClsService<TenantClsStore>;
      const tenantPrisma = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      );
      repo = new PrismaCatalogSettingsRepository(tenantPrisma);
    });

    beforeEach(() => {
      currentTenantId = BASELINE_TENANT_ID;
      trackedTenantIds.length = 0;
      trackedGlobalPriceListIds.length = 0;
    });

    afterEach(async () => {
      currentTenantId = BASELINE_TENANT_ID;
      const prisma = integrationPrisma();
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

    async function seedTenant(): Promise<string> {
      const id = randomUUID();
      await integrationPrisma().tenant.create({
        data: {
          id,
          name: `Replace Tenant ${id.slice(0, 8)}`,
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
      await integrationPrisma().globalPriceList.create({
        data: { id, name: globalName(id, suffix), isDefault: false },
      });
      trackedGlobalPriceListIds.push(id);
      return id;
    }

    async function seedBinding(
      tenantId: string,
      globalPriceListId: string,
      isCatalogDefault: boolean,
    ): Promise<void> {
      await integrationPrisma().tenantCatalogPriceList.create({
        data: { tenantId, globalPriceListId, isCatalogDefault },
      });
    }

    /**
     * Build a valid `TenantCatalogSettings` aggregate via `fromPersistence`.
     * Bindings are stamped with the real tenantId before the invariant
     * check, satisfying `TENANT_MISMATCH` without DB roundtrips.
     */
    function mkAggregate(input: {
      tenantId: string;
      catalogPublished: boolean;
      mode: StockMode;
      customQty: number | null;
      bindings: Array<{
        globalPriceListId: string;
        name: string;
        isCatalogDefault: boolean;
      }>;
    }): TenantCatalogSettings {
      const now = new Date();
      const bindings = input.bindings.map((b) => {
        const props: TenantCatalogPriceListBindingProps = {
          id: randomUUID(),
          tenantId: input.tenantId,
          globalPriceListId: b.globalPriceListId,
          isCatalogDefault: b.isCatalogDefault,
          createdAt: now,
          updatedAt: now,
          globalPriceList: { id: b.globalPriceListId, name: b.name },
        };
        return TenantCatalogPriceListBinding.fromPersistence(props);
      });
      return TenantCatalogSettings.fromPersistence({
        tenant: {
          tenantId: input.tenantId,
          isActive: true,
          catalogPublished: input.catalogPublished,
          catalogStockPresentationDefault: input.mode,
          catalogStockPresentationDefaultCustomQty: input.customQty,
          updatedAt: now,
        },
        bindings,
      });
    }

    // ── T1 — atomic replacement of bindings + tenant publication/stock ─────

    it('T1: replaces bindings AND flips catalogPublished + stock mode + customQty in one commit', async () => {
      const prisma = integrationPrisma();
      const tenantId = await seedTenant();
      const gOldDefault = await seedGlobalPriceList('old-default');
      const gOldNonDefault = await seedGlobalPriceList('old-nd');
      await seedBinding(tenantId, gOldDefault, true);
      await seedBinding(tenantId, gOldNonDefault, false);

      // Replacement: 3 bindings (1 default), publication ON, CUSTOM_QUANTITY qty=12.
      const gNewDefault = await seedGlobalPriceList('new-default');
      const gNewA = await seedGlobalPriceList('new-a');
      const gNewB = await seedGlobalPriceList('new-b');
      const aggregate = mkAggregate({
        tenantId,
        catalogPublished: true,
        mode: 'CUSTOM_QUANTITY',
        customQty: 12,
        bindings: [
          { globalPriceListId: gNewA, name: 'A', isCatalogDefault: false },
          { globalPriceListId: gNewB, name: 'B', isCatalogDefault: false },
          {
            globalPriceListId: gNewDefault,
            name: 'D',
            isCatalogDefault: true,
          },
        ],
      });

      currentTenantId = tenantId;
      const result = await repo.replace(aggregate, 'actor-replace-1');

      // Returned aggregate — 3 bindings, correct default + ascending order.
      expect(result.bindings.map((b) => b.globalPriceListId)).toEqual(
        [gNewA, gNewB, gNewDefault].sort((a, b) => a.localeCompare(b)),
      );
      expect(result.defaultBinding?.globalPriceListId).toBe(gNewDefault);
      expect(result.catalogPublished).toBe(true);
      expect(result.stockPresentationDefault.mode).toBe('CUSTOM_QUANTITY');
      expect(result.stockPresentationDefault.customQuantity).toBe(12);

      // Persisted bindings table — exactly 3 rows, no gOld* leaks.
      const persistedBindings = await prisma.tenantCatalogPriceList.findMany({
        where: { tenantId },
        orderBy: { globalPriceListId: 'asc' },
      });
      expect(persistedBindings).toHaveLength(3);
      expect(
        new Set(persistedBindings.map((b) => b.globalPriceListId)),
      ).toEqual(new Set([gNewA, gNewB, gNewDefault]));
      const defaultRows = persistedBindings.filter((b) => b.isCatalogDefault);
      expect(defaultRows).toHaveLength(1);
      expect(defaultRows[0].globalPriceListId).toBe(gNewDefault);

      // Persisted tenant row — publication + stock + customQty flipped.
      const tenantRow = await prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
      });
      expect(tenantRow.catalogPublished).toBe(true);
      expect(tenantRow.catalogStockPresentationDefault).toBe('CUSTOM_QUANTITY');
      expect(tenantRow.catalogStockPresentationDefaultCustomQty).toBe(12);
    });

    // ── T2 — repeated identical replacement remains one row per binding ────

    it('T2: a second replace with the same aggregate does not duplicate rows or create multiple defaults', async () => {
      const prisma = integrationPrisma();
      const tenantId = await seedTenant();
      const gA = await seedGlobalPriceList('a');
      const gB = await seedGlobalPriceList('b');
      const gC = await seedGlobalPriceList('c');
      const aggregate = mkAggregate({
        tenantId,
        catalogPublished: false,
        mode: 'ABSTRACT_STATUS',
        customQty: null,
        bindings: [
          { globalPriceListId: gA, name: 'A', isCatalogDefault: false },
          { globalPriceListId: gB, name: 'B', isCatalogDefault: false },
          { globalPriceListId: gC, name: 'C', isCatalogDefault: true },
        ],
      });

      currentTenantId = tenantId;
      await repo.replace(aggregate, 'actor-first');

      const firstBindings = await prisma.tenantCatalogPriceList.findMany({
        where: { tenantId },
      });
      expect(firstBindings).toHaveLength(3);
      expect(firstBindings.filter((b) => b.isCatalogDefault)).toHaveLength(1);

      // Same aggregate, different actor — identical DB state.
      await repo.replace(aggregate, 'actor-second');

      const secondBindings = await prisma.tenantCatalogPriceList.findMany({
        where: { tenantId },
        orderBy: { globalPriceListId: 'asc' },
      });
      expect(secondBindings).toHaveLength(3);
      const secondDefaults = secondBindings.filter((b) => b.isCatalogDefault);
      expect(secondDefaults).toHaveLength(1);
      expect(secondDefaults[0].globalPriceListId).toBe(gC);

      // Binding IDs are stable across calls — upsert preserves row id.
      expect(secondBindings.map((b) => b.id).sort()).toEqual(
        firstBindings.map((b) => b.id).sort(),
      );
    });

    // ── T3 — stale bindings removed, requested bindings retained ───────────

    it('T3: drops only bindings absent from the requested set and keeps every requested binding', async () => {
      const prisma = integrationPrisma();
      const tenantId = await seedTenant();
      const gKeepA = await seedGlobalPriceList('keep-a');
      const gKeepB = await seedGlobalPriceList('keep-b');
      const gDrop = await seedGlobalPriceList('drop');
      await seedBinding(tenantId, gKeepA, true);
      await seedBinding(tenantId, gKeepB, false);
      await seedBinding(tenantId, gDrop, false);

      // Replace with only gKeepA + gKeepB — gDrop deleted, gKeepB default.
      const aggregate = mkAggregate({
        tenantId,
        catalogPublished: false,
        mode: 'SYSTEM_STATUS',
        customQty: null,
        bindings: [
          { globalPriceListId: gKeepA, name: 'A', isCatalogDefault: false },
          { globalPriceListId: gKeepB, name: 'B', isCatalogDefault: true },
        ],
      });

      currentTenantId = tenantId;
      const result = await repo.replace(aggregate, 'actor-stale');

      // Returned aggregate — gDrop absent, gKeepB is default.
      expect(result.bindings.map((b) => b.globalPriceListId)).toEqual(
        [gKeepA, gKeepB].sort(),
      );
      expect(result.defaultBinding?.globalPriceListId).toBe(gKeepB);
      expect(result.bindings.map((b) => b.globalPriceListId)).not.toContain(
        gDrop,
      );

      // Persisted table — same shape: gDrop deleted, default is gKeepB.
      const persisted = await prisma.tenantCatalogPriceList.findMany({
        where: { tenantId },
        orderBy: { globalPriceListId: 'asc' },
      });
      expect(persisted).toHaveLength(2);
      expect(new Set(persisted.map((b) => b.globalPriceListId))).toEqual(
        new Set([gKeepA, gKeepB]),
      );
      const defaults = persisted.filter((b) => b.isCatalogDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].globalPriceListId).toBe(gKeepB);
    });

    // ── T4 — returned aggregate equals committed persisted settings ─────────

    it('T4: the aggregate returned by replace matches a fresh findByTenantId projection of the committed state', async () => {
      const tenantId = await seedTenant();
      const gD = await seedGlobalPriceList('d');
      const gE = await seedGlobalPriceList('e');
      const gF = await seedGlobalPriceList('f');
      const aggregate = mkAggregate({
        tenantId,
        catalogPublished: true,
        mode: 'HIDDEN',
        customQty: null,
        bindings: [
          { globalPriceListId: gD, name: 'D', isCatalogDefault: true },
          { globalPriceListId: gE, name: 'E', isCatalogDefault: false },
          { globalPriceListId: gF, name: 'F', isCatalogDefault: false },
        ],
      });

      currentTenantId = tenantId;
      const replaced = await repo.replace(aggregate, 'actor-commit-eq');
      const fresh = await repo.findByTenantId(tenantId);

      expect(replaced).not.toBeNull();
      expect(fresh).not.toBeNull();

      // Tenant fields — publication + stock + customQty match.
      expect(fresh!.tenantId).toBe(replaced.tenantId);
      expect(fresh!.catalogPublished).toBe(true);
      expect(fresh!.stockPresentationDefault.mode).toBe('HIDDEN');
      expect(fresh!.stockPresentationDefault.customQuantity).toBeNull();

      // Bindings — same ids in the same ascending order, same default.
      expect(fresh!.bindings.map((b) => b.globalPriceListId)).toEqual(
        replaced.bindings.map((b) => b.globalPriceListId),
      );
      expect(fresh!.defaultBinding?.globalPriceListId).toBe(gD);

      // Names reconstructed identically from the joined GlobalPriceList.
      expect(fresh!.bindings.map((b) => b.globalPriceList.name)).toEqual(
        replaced.bindings.map((b) => b.globalPriceList.name),
      );
    });
  },
);
