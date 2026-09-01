/**
 * F1.WU2b.1d-2B — real PostgreSQL rollback/isolation evidence for
 * PrismaCatalogSettingsRepository.replace against `nest-practice-test`
 * (port 5433 — NEVER dev).
 *
 * Coverage:
 *   T1 — replace rejects with `INVALID_GLOBAL_PRICE_LIST` when a requested
 *        `globalPriceListId` does not exist.
 *   T2 — after rejection, prior bindings/default + tenant publication +
 *        stock-presentation columns remain exactly as before (rolled back).
 *   T3 — Tenant A's successful replace AND Tenant A's rejected replace
 *        NEVER mutate Tenant B's settings/bindings (cross-tenant isolation).
 *
 * Mirrors `prisma-catalog-settings.repository.replace.integration.spec.ts`:
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

const tenantSlug = (id: string): string => `cs-rb-${id.slice(0, 8)}`;
const globalName = (id: string, suffix: string): string =>
  `cs-rb-list-${id.slice(0, 8)}-${suffix}`;
type StockMode =
  | 'SYSTEM_STATUS'
  | 'ABSTRACT_STATUS'
  | 'CUSTOM_QUANTITY'
  | 'HIDDEN';

describeIfDb(
  'PrismaCatalogSettingsRepository.replace rollback/isolation (Integration - Real DB)',
  () => {
    let repo: PrismaCatalogSettingsRepository;
    /** Mutable CLS tenant — cross-tenant tests switch this. */
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
        // `replace` calls `runInTransaction` which sets the tx client slot;
        // no-op is fine — every test runs the full flow inline.
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

    async function seedTenant(label: string): Promise<string> {
      const id = randomUUID();
      await integrationPrisma().tenant.create({
        data: {
          id,
          name: `Rollback Tenant ${label} ${id.slice(0, 8)}`,
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

    /** Snapshot persisted bindings + tenant stock/publication for diff. */
    async function snapshot(tenantId: string) {
      const prisma = integrationPrisma();
      const [bindings, tenant] = await Promise.all([
        prisma.tenantCatalogPriceList.findMany({
          where: { tenantId },
          orderBy: { globalPriceListId: 'asc' },
        }),
        prisma.tenant.findUnique({ where: { id: tenantId } }),
      ]);
      const def = bindings.find((b) => b.isCatalogDefault);
      return {
        bindingIds: bindings.map((b) => b.id).sort(),
        bindingGlobalIds: bindings.map((b) => b.globalPriceListId).sort(),
        defaultGlobalId: def?.globalPriceListId ?? null,
        catalogPublished: tenant?.catalogPublished ?? null,
        mode: tenant?.catalogStockPresentationDefault ?? null,
        customQty: tenant?.catalogStockPresentationDefaultCustomQty ?? null,
      };
    }

    // ── T1 — nonexistent GlobalPriceList ID rejects ────────────────────────

    it('T1: replace rejects with INVALID_GLOBAL_PRICE_LIST when a binding id does not exist', async () => {
      const tenantId = await seedTenant('T1');
      const gRealA = await seedGlobalPriceList('real-a');
      const gRealB = await seedGlobalPriceList('real-b');
      await seedBinding(tenantId, gRealA, true);
      await seedBinding(tenantId, gRealB, false);

      const gMissing = randomUUID();
      const aggregate = mkAggregate({
        tenantId,
        catalogPublished: true,
        mode: 'CUSTOM_QUANTITY',
        customQty: 9,
        bindings: [
          { globalPriceListId: gRealA, name: 'A', isCatalogDefault: false },
          {
            globalPriceListId: gMissing,
            name: 'GHOST',
            isCatalogDefault: true,
          },
          { globalPriceListId: gRealB, name: 'B', isCatalogDefault: false },
        ],
      });

      currentTenantId = tenantId;
      await expect(repo.replace(aggregate, 'actor-rollback-1')).rejects.toThrow(
        /INVALID_GLOBAL_PRICE_LIST/,
      );
    });

    // ── T2 — after rejection, prior state remains unchanged ────────────────

    it('T2: rejected replace leaves bindings + default + tenant publication + stock columns exactly as before', async () => {
      const tenantId = await seedTenant('T2');
      const gKeep = await seedGlobalPriceList('keep');
      const gDrop = await seedGlobalPriceList('drop');
      // Pre-state: gKeep default, gDrop non-default; pub=false, SYSTEM_STATUS, qty=null.
      await seedBinding(tenantId, gKeep, true);
      await seedBinding(tenantId, gDrop, false);

      const before = await snapshot(tenantId);
      expect(before.bindingIds).toHaveLength(2);
      expect(before.defaultGlobalId).toBe(gKeep);
      expect(before.catalogPublished).toBe(false);
      expect(before.mode).toBe('SYSTEM_STATUS');
      expect(before.customQty).toBeNull();

      // Replace asks for a ghost id and flips every tenant column to a
      // value that contradicts the pre-state (publication=false,
      // SYSTEM_STATUS, qty=null). CUSTOM_QUANTITY+42 satisfies the
      // tenant-stock invariant while still flipping all three columns.
      const gMissing = randomUUID();
      const aggregate = mkAggregate({
        tenantId,
        catalogPublished: true,
        mode: 'CUSTOM_QUANTITY',
        customQty: 42,
        bindings: [
          {
            globalPriceListId: gMissing,
            name: 'GHOST',
            isCatalogDefault: true,
          },
        ],
      });

      currentTenantId = tenantId;
      await expect(repo.replace(aggregate, 'actor-rollback-2')).rejects.toThrow(
        /INVALID_GLOBAL_PRICE_LIST/,
      );

      const after = await snapshot(tenantId);
      // Bindings table — same ids + same default + no ghost row inserted + nothing deleted.
      expect(after.bindingIds).toEqual(before.bindingIds);
      expect(after.bindingGlobalIds).toEqual(before.bindingGlobalIds);
      expect(after.defaultGlobalId).toBe(before.defaultGlobalId);
      expect(after.bindingGlobalIds).not.toContain(gMissing);
      // Tenant publication + stock + customQty columns unchanged.
      expect(after.catalogPublished).toBe(before.catalogPublished);
      expect(after.mode).toBe(before.mode);
      expect(after.customQty).toBe(before.customQty);
    });

    // ── T3 — Tenant A replace success AND reject never mutate Tenant B ─────

    it('T3: Tenant A successful replace AND Tenant A rejected replace never mutate Tenant B settings/bindings', async () => {
      const tenantA = await seedTenant('A');
      const tenantB = await seedTenant('B');

      // Seed Tenant B with bindings before any Tenant A action so we can
      // prove B is unaffected by both branches. seedTenant leaves the
      // publication + stock columns at their baseline defaults (false,
      // SYSTEM_STATUS, null) — exactly what we want to assert against.
      const gBDefault = await seedGlobalPriceList('B-default');
      const gBNonDefault = await seedGlobalPriceList('B-nd');
      await seedBinding(tenantB, gBDefault, true);
      await seedBinding(tenantB, gBNonDefault, false);
      const tenantBBefore = await snapshot(tenantB);

      // Seed Tenant A with one pre-existing binding — proves T3 success
      // does not leak across tenants.
      const gAOld = await seedGlobalPriceList('A-old');
      await seedBinding(tenantA, gAOld, true);

      // ── Branch 3a — Tenant A successful replace. ────────────────────────
      const gANewDefault = await seedGlobalPriceList('A-new-default');
      const gANewNonDefault = await seedGlobalPriceList('A-new-nd');
      currentTenantId = tenantA;
      await repo.replace(
        mkAggregate({
          tenantId: tenantA,
          catalogPublished: true,
          mode: 'ABSTRACT_STATUS',
          customQty: null,
          bindings: [
            {
              globalPriceListId: gANewNonDefault,
              name: 'A-nd',
              isCatalogDefault: false,
            },
            {
              globalPriceListId: gANewDefault,
              name: 'A-d',
              isCatalogDefault: true,
            },
          ],
        }),
        'actor-A-success',
      );

      const tenantBAfterSuccess = await snapshot(tenantB);
      expect(tenantBAfterSuccess.bindingIds).toEqual(tenantBBefore.bindingIds);
      expect(tenantBAfterSuccess.bindingGlobalIds).toEqual(
        tenantBBefore.bindingGlobalIds,
      );
      expect(tenantBAfterSuccess.defaultGlobalId).toBe(
        tenantBBefore.defaultGlobalId,
      );
      expect(tenantBAfterSuccess.catalogPublished).toBe(
        tenantBBefore.catalogPublished,
      );
      expect(tenantBAfterSuccess.mode).toBe(tenantBBefore.mode);
      expect(tenantBAfterSuccess.customQty).toBe(tenantBBefore.customQty);

      // ── Branch 3b — Tenant A rejected replace with a ghost id. ──────────
      currentTenantId = tenantA;
      await expect(
        repo.replace(
          mkAggregate({
            tenantId: tenantA,
            catalogPublished: false,
            mode: 'CUSTOM_QUANTITY',
            customQty: 7,
            bindings: [
              {
                globalPriceListId: randomUUID(),
                name: 'GHOST',
                isCatalogDefault: true,
              },
            ],
          }),
          'actor-A-fail',
        ),
      ).rejects.toThrow(/INVALID_GLOBAL_PRICE_LIST/);

      const tenantBAfterReject = await snapshot(tenantB);
      expect(tenantBAfterReject.bindingIds).toEqual(tenantBBefore.bindingIds);
      expect(tenantBAfterReject.bindingGlobalIds).toEqual(
        tenantBBefore.bindingGlobalIds,
      );
      expect(tenantBAfterReject.defaultGlobalId).toBe(
        tenantBBefore.defaultGlobalId,
      );
      expect(tenantBAfterReject.catalogPublished).toBe(
        tenantBBefore.catalogPublished,
      );
      expect(tenantBAfterReject.mode).toBe(tenantBBefore.mode);
      expect(tenantBAfterReject.customQty).toBe(tenantBBefore.customQty);
    });
  },
);
