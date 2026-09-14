/**
 * TenantPrismaService — real PostgreSQL service-bound integration spec
 * (WU2 of `preserve-tenant-transaction-scope`). Proves the SERVICE
 * transaction path against real Prisma 6.19.2 + PostgreSQL: the outer
 * `$transaction` starts from the tenant-extended root, so the ambient
 * callback `tx` carries the tenant query extension. Nothing is mocked;
 * cross-tenant expectations are paired with UNSCOPED fixture reloads
 * through `integrationPrisma()`. Transaction cardinality for nesting is
 * owned by WU1's unit root call-count test (U2), not asserted here.
 * Skip guard is identical to `tenant-isolation.spec.ts`.
 */
import { Prisma } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { PrismaService } from './prisma.service';
import { TenantPrismaService } from './tenant-prisma.service';
import { TENANT_SCOPED_MODELS } from '../tenant/tenant-scoped-models.constant';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';
import {
  integrationPrisma,
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
} from '../../../test/integration/reset-db';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;

const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

// Pinned UUIDs — same convention as `tenant-isolation.spec.ts`.
const tenantAId = '00000000-0000-0000-0000-0000000000aa';
const tenantBId = '00000000-0000-0000-0000-0000000000bb';

// Instance-level delegation onto a `PrismaService` prototype; no behavior mocked.
const makePrismaServiceBase = (): PrismaService =>
  Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    integrationPrisma(),
  );

describeIfDb(
  'TenantPrismaService.runInTransaction (PostgreSQL integration)',
  () => {
    // Stateful CLS shim: mutable Map behind the get/set surface.
    const clsStore = new Map<keyof TenantClsStore | string, unknown>();
    const cls = {
      get: (key: keyof TenantClsStore | string) => clsStore.get(key),
      set: (key: keyof TenantClsStore | string, value: unknown) => {
        clsStore.set(key, value);
      },
    } as unknown as ClsService<TenantClsStore>;

    const makeService = (): TenantPrismaService =>
      new TenantPrismaService(makePrismaServiceBase(), cls);

    // `isSuperAdmin: false` so the super-admin bypass cannot mask a predicate.
    const asTenant = (tenantId: string): void => {
      clsStore.set('tenantId', tenantId);
      clsStore.set('isSuperAdmin', false);
    };

    const expectP2025 = (e: unknown): void => {
      expect(e).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((e as Prisma.PrismaClientKnownRequestError).code).toBe('P2025');
    };

    let fixtureId: string;
    const fixtureName = 'a-owned-fixture';
    const rawFind = (id: string) =>
      integrationPrisma().product.findUnique({ where: { id } });

    // One outer runInTransaction under CLS tenant B; returns the caught error.
    const rejectUnderB = async (
      work: (s: TenantPrismaService) => Promise<unknown>,
    ): Promise<unknown> => {
      const service = makeService();
      asTenant(tenantBId);
      return service
        .runInTransaction(() => work(service))
        .catch((e: unknown) => e);
    };

    // Unscoped reload of the A-owned fixture: still present, still A's.
    const expectUnchangedA = async (): Promise<void> => {
      const reloaded = await rawFind(fixtureId);
      expect(reloaded).not.toBeNull();
      expect(reloaded?.tenantId).toBe(tenantAId);
      expect(reloaded?.name).toBe(fixtureName);
    };

    // Post-commit ownership: created under B, absent under A.
    const expectOwnedB = async (
      created: { id: string; tenantId: string },
      name: string,
    ): Promise<void> => {
      expect(created.tenantId).toBe(tenantBId);
      expect((await rawFind(created.id))?.tenantId).toBe(tenantBId);
      const underA = await integrationPrisma().product.findMany({
        where: { tenantId: tenantAId, name },
      });
      expect(underA).toHaveLength(0);
    };

    beforeAll(async () => {
      await resetAndSeedBaseline();
    });

    beforeEach(async () => {
      clsStore.clear();
      await integrationPrisma().tenant.createMany({
        data: [tenantAId, tenantBId].map((id, i) => ({
          id,
          name: `Tenant ${i === 0 ? 'A' : 'B'}`,
          slug: `tenant-${i === 0 ? 'a' : 'b'}-${id.slice(0, 8)}`,
        })),
        skipDuplicates: true,
      });
      const fixture = await integrationPrisma().product.create({
        data: { name: fixtureName, tenantId: tenantAId },
      });
      fixtureId = fixture.id;
    });

    afterEach(async () => {
      await resetAndSeedBaseline();
    });

    afterAll(async () => {
      await disconnectIntegrationPrisma();
    });

    it('allowlists Product so the tenant predicates under test are active', () => {
      expect(TENANT_SCOPED_MODELS.has('Product')).toBe(true);
    });

    it('returns null for a foreign (A-owned) id read under CLS tenant B', async () => {
      const service = makeService();
      asTenant(tenantBId);

      await service.runInTransaction(async () => {
        const found = await service
          .getClient()
          .product.findUnique({ where: { id: fixtureId } });
        expect(found).toBeNull();
      });
    });

    it('returns the row for an own-tenant read under CLS tenant A (gate-correctness baseline)', async () => {
      const service = makeService();
      asTenant(tenantAId);

      await service.runInTransaction(async () => {
        const found = await service
          .getClient()
          .product.findUnique({ where: { id: fixtureId } });
        expect(found).not.toBeNull();
        expect(found?.tenantId).toBe(tenantAId);
      });
    });

    it('rejects a cross-tenant update with P2025 and preserves A-owned state after rollback', async () => {
      const error = await rejectUnderB((s) =>
        s.getClient().product.update({
          where: { id: fixtureId },
          data: { name: 'mutated-by-b' },
        }),
      );

      expectP2025(error);
      await expectUnchangedA();
    });

    it('rejects a cross-tenant delete with P2025 and preserves A-owned state after rollback', async () => {
      const error = await rejectUnderB((s) =>
        s.getClient().product.delete({ where: { id: fixtureId } }),
      );

      expectP2025(error);
      await expectUnchangedA();
    });

    it('persists an outer create with foreign tenantId under CLS tenant B after commit', async () => {
      const service = makeService();
      asTenant(tenantBId);

      const created = await service.runInTransaction(async () =>
        service.getClient().product.create({
          data: { name: 'forced', tenantId: tenantAId },
        }),
      );

      await expectOwnedB(created, 'forced');
    });

    it('returns null for the foreign id on the nested CLS path and reuses the outer callback client', async () => {
      const service = makeService();
      asTenant(tenantBId);

      let outerClient: unknown;
      await service.runInTransaction(async () => {
        outerClient = service.getClient();
        await service.runInTransaction(async () => {
          expect(service.getClient()).toBe(outerClient);
          const found = await service
            .getClient()
            .product.findUnique({ where: { id: fixtureId } });
          expect(found).toBeNull();
        });
      });

      const reloaded = await rawFind(fixtureId);
      expect(reloaded?.tenantId).toBe(tenantAId);
      expect(reloaded?.name).toBe(fixtureName);
    });

    it('persists a nested create with foreign tenantId under CLS tenant B after commit', async () => {
      const service = makeService();
      asTenant(tenantBId);

      const created = await service.runInTransaction(async () =>
        service.runInTransaction(async () =>
          service.getClient().product.create({
            data: { name: 'nested', tenantId: tenantAId },
          }),
        ),
      );

      await expectOwnedB(created, 'nested');
    });
  },
);
