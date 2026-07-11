/**
 * Tenant Prisma isolation — integration spec against the dedicated
 * test DB.
 *
 * Proves that `createTenantScopedPrisma` enforces per-tenant
 * read/write isolation through the `ClsService<TenantClsStore>`
 * store. This file lives under `src/` without an `.integration`
 * suffix because the tenant-scoping work landed before the
 * integration-naming convention was adopted. The unit Jest config
 * `testPathIgnorePatterns` lists it explicitly so `pnpm test` never
 * reaches a DB; the integration config picks it up via its
 * `testMatch` block.
 *
 * ## Test-DB isolation
 *
 * The two tracked-id arrays (`createdProductIds`, `createdSaleIds`,
 * `createdUserIds`) were removed in favour of `resetAndSeedBaseline()`
 * (see `test/integration/reset-db.ts`) which uses
 * `TRUNCATE TABLE "tenants" CASCADE` + `TRUNCATE TABLE "users" CASCADE`
 * + a single re-seed of the baseline tenant. That makes a mid-test
 * failure impossible to leak rows from: the cleanup runs even when
 * an assertion throws.
 *
 * Tenant A/B IDs are pinned (instead of `crypto.randomUUID()` per
 * module load) so the cleanup can deterministically recreate them in
 * `beforeEach` and so slugs that derive from the first 8 hex chars
 * stay stable across runs.
 *
 * ## Skip guard
 *
 * `SKIP_DB_INTEGRATION=1` or unset `DATABASE_URL` skips the whole
 * describe — same convention as the e4 and stock specs.
 */
import {
  integrationPrisma,
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
} from '../../../test/integration/reset-db';
import { createTenantScopedPrisma } from './tenant-prisma.factory';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;

const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb('Tenant Prisma isolation (integration)', () => {
  const ctx: TenantClsStore = {
    userId: 'test-user',
    tenantId: null,
    tenantSlug: null,
    isSuperAdmin: false,
  };

  const cls = {
    get: jest.fn((key: keyof TenantClsStore) => ctx[key]),
  };

  // Pinned UUID-shaped IDs. The first 8 hex chars feed the slug so
  // a fixed prefix (`00000000`) keeps slugs stable across runs —
  // important because `Tenant.slug` has a UNIQUE constraint.
  const tenantAId = '00000000-0000-0000-0000-0000000000aa';
  const tenantBId = '00000000-0000-0000-0000-0000000000bb';

  beforeAll(async () => {
    // Force the singleton construction early so a misconfigured
    // DATABASE_URL throws here (loud), not inside the first test
    // (cryptic).
    integrationPrisma();
    await resetAndSeedBaseline();
  });

  beforeEach(async () => {
    const prisma = integrationPrisma();
    // The previous `createMany … skipDuplicates` pattern is kept
    // — the `resetAndSeedBaseline` in afterEach deliberately wipes
    // these so each test starts from "Tenant A and Tenant B exist".
    await prisma.tenant.createMany({
      data: [
        {
          id: tenantAId,
          name: 'Tenant A',
          slug: `tenant-a-${tenantAId.slice(0, 8)}`,
        },
        {
          id: tenantBId,
          name: 'Tenant B',
          slug: `tenant-b-${tenantBId.slice(0, 8)}`,
        },
      ],
      skipDuplicates: true,
    });
  });

  afterEach(async () => {
    // TRUNCATE … CASCADE: robust against mid-test failure. The
    // helper re-seeds the baseline tenant after truncation so any
    // other spec in the same run (or any later test within this
    // suite) sees a known starting state.
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await disconnectIntegrationPrisma();
  });

  it('creates in Tenant A and findMany in Tenant B returns empty', async () => {
    const prisma = integrationPrisma();
    ctx.tenantId = tenantAId;
    ctx.isSuperAdmin = false;
    const tenantAClient = createTenantScopedPrisma(prisma, cls as any);

    const created = await tenantAClient.product.create({
      data: { name: 'Ibuprofeno' } as any,
    });

    ctx.tenantId = tenantBId;
    const tenantBClient = createTenantScopedPrisma(prisma, cls as any);
    const foundInB = await tenantBClient.product.findMany({
      where: { id: created.id },
    });

    expect(foundInB).toHaveLength(0);
  });

  it('findUnique by id from another tenant returns null', async () => {
    const prisma = integrationPrisma();
    ctx.tenantId = tenantAId;
    const tenantAClient = createTenantScopedPrisma(prisma, cls as any);
    const created = await tenantAClient.product.create({
      data: { name: 'Aspirina' } as any,
    });

    ctx.tenantId = tenantBId;
    const tenantBClient = createTenantScopedPrisma(prisma, cls as any);
    const found = await tenantBClient.product.findUnique({
      where: { id: created.id },
    });

    expect(found).toBeNull();
  });

  it('super-admin global context can read records from both tenants', async () => {
    const prisma = integrationPrisma();
    ctx.tenantId = tenantAId;
    const tenantAClient = createTenantScopedPrisma(prisma, cls as any);
    const productA = await tenantAClient.product.create({
      data: { name: 'Producto A' } as any,
    });

    ctx.tenantId = tenantBId;
    const tenantBClient = createTenantScopedPrisma(prisma, cls as any);
    const productB = await tenantBClient.product.create({
      data: { name: 'Producto B' } as any,
    });

    ctx.tenantId = null;
    ctx.isSuperAdmin = true;
    const superAdminClient = createTenantScopedPrisma(prisma, cls as any);
    const allProducts = await superAdminClient.product.findMany({
      where: { id: { in: [productA.id, productB.id] } },
    });

    expect(allProducts).toHaveLength(2);
  });

  it('create enforces current tenantId in persisted record', async () => {
    const prisma = integrationPrisma();
    ctx.tenantId = tenantAId;
    ctx.isSuperAdmin = false;
    const tenantClient = createTenantScopedPrisma(prisma, cls as any);

    const created = await tenantClient.product.create({
      data: { name: 'Naproxeno', tenantId: tenantBId } as any,
    });

    expect(created.tenantId).toBe(tenantAId);
  });

  it('update from Tenant B on Tenant A product is not found', async () => {
    const prisma = integrationPrisma();
    ctx.tenantId = tenantAId;
    const tenantAClient = createTenantScopedPrisma(prisma, cls as any);
    const created = await tenantAClient.product.create({
      data: { name: 'Omeprazol' } as any,
    });

    ctx.tenantId = tenantBId;
    const tenantBClient = createTenantScopedPrisma(prisma, cls as any);

    await expect(
      tenantBClient.product.update({
        where: { id: created.id },
        data: { name: 'Omeprazol editado' },
      }),
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  it('findUnique sale by id from another tenant returns null', async () => {
    const prisma = integrationPrisma();
    ctx.tenantId = tenantAId;
    const tenantAClient = createTenantScopedPrisma(prisma, cls as any);
    const userId = crypto.randomUUID();
    await tenantAClient.user.create({
      data: {
        id: userId,
        email: `cashier-${userId}@example.com`,
        hashedPassword: 'hashed',
        name: 'Cashier A',
      },
    });

    const created = await tenantAClient.sale.create({
      data: { userId, status: 'DRAFT' } as any,
    });

    ctx.tenantId = tenantBId;
    const tenantBClient = createTenantScopedPrisma(prisma, cls as any);
    const found = await tenantBClient.sale.findUnique({
      where: { id: created.id },
    });

    expect(found).toBeNull();
  });

  it('cross-tenant product update has zero effect on original tenant data', async () => {
    const prisma = integrationPrisma();
    ctx.tenantId = tenantAId;
    const tenantAClient = createTenantScopedPrisma(prisma, cls as any);
    const created = await tenantAClient.product.create({
      data: { name: 'Paracetamol' } as any,
    });

    ctx.tenantId = tenantBId;
    const tenantBClient = createTenantScopedPrisma(prisma, cls as any);

    await expect(
      tenantBClient.product.update({
        where: { id: created.id },
        data: { name: 'Paracetamol alterado' },
      }),
    ).rejects.toMatchObject({ code: 'P2025' });

    ctx.tenantId = tenantAId;
    const reloaded = await tenantAClient.product.findUnique({
      where: { id: created.id },
    });

    expect(reloaded?.name).toBe('Paracetamol');
  });
});
