/**
 * INTEGRATION SPEC: PrismaDeliveryRouteRepository — delivery-routes / WU3 (task 3.19).
 *
 * Proves the WU2 adapter contract against the real `nest-practice-test`
 * database (port 5433 — NEVER the dev DB):
 *
 *   1. Tenant scoping — `findById`/`findOneWithStops`/`findDriverUserIdById`
 *      return null for a route that lives in another tenant.
 *   2. `findOneWithStops` projection — route + driver + stops with embedded
 *      `saleFolio`, customer name and full shipping address.
 *   3. `findDriverUserIdById` — `{ driverUserId }` on a hit, null on a miss.
 *   4. ADR-7 partial unique index — saving a second ACTIVE route that shares
 *      a sale raises P2002, which the adapter maps to
 *      `DeliveryRouteSaleAlreadyInActiveRouteError` (HTTP 409 domain code).
 *
 * Mirrors `prisma-quotation.repository.integration.spec.ts` /
 * `prisma-promotion.repository.integration.spec.ts`: shared Prisma client +
 * CLS shim + `resetAndSeedBaseline()` in `afterEach`. The CLS shim exposes
 * a MUTABLE tenant so the cross-tenant tests can switch the ambient tenant
 * context (the tenant-scoped Prisma factory injects the CLS tenantId into
 * every top-level `where` — the explicit port `tenantId` is defense in depth).
 *
 * Skips gracefully when the test DB is unreachable (`SKIP_DB_INTEGRATION=1`
 * or unset `DATABASE_URL`).
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { DeliveryRoute, type SaleEligibilitySnapshot } from '../domain/delivery-route.entity';
import { DeliveryRouteSaleAlreadyInActiveRouteError } from '../domain/delivery-route.errors';
import { PrismaDeliveryRouteRepository } from './prisma-delivery-route.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb('PrismaDeliveryRouteRepository (Integration - Real DB)', () => {
  let prisma: PrismaClient;
  let repo: PrismaDeliveryRouteRepository;
  let tenantId: string;
  /** Mutable CLS tenant — cross-tenant tests switch this to a foreign tenant. */
  let currentTenantId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    await resetAndSeedBaseline();

    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) {
      throw new Error(
        'No tenant found for integration test. globalSetup must have seeded one — ' +
          'verify .env.test and that `pnpm run test:db:up` has the container running.',
      );
    }
    tenantId = tenant.id;
    currentTenantId = tenantId;
    expect(tenantId).toBe(BASELINE_TENANT_ID);

    const cls: Pick<ClsService<TenantClsStore>, 'get'> = {
      get: (key: string) => {
        if (key === 'tenantId') return currentTenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    };
    const tenantPrisma = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls as ClsService<TenantClsStore>,
    );
    repo = new PrismaDeliveryRouteRepository(tenantPrisma);
  });

  afterEach(async () => {
    // Reset CLS to the baseline tenant before the cascade reset.
    currentTenantId = tenantId;
    // Robust cascade reset — wipes routes/stops/sales/users/tenants and
    // re-seeds the baseline tenant for the next test.
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await disconnectIntegrationPrisma();
  });

  // ── Fixtures ───────────────────────────────────────────────────────────

  /** Seed a driver user for the baseline tenant. */
  async function seedDriver(): Promise<{ id: string; name: string; email: string }> {
    const id = randomUUID();
    const name = 'Juan Driver';
    const email = `driver-${randomUUID()}@test.local`;
    await prisma.user.create({
      data: { id, email, hashedPassword: 'test', name, isActive: true },
    });
    return { id, name, email };
  }

  /** Seed a customer + shipping address (tenant-scoped FK chain). */
  async function seedCustomerAndAddress(): Promise<{
    customerId: string;
    addressId: string;
  }> {
    const customerId = randomUUID();
    await prisma.customer.create({
      data: {
        id: customerId,
        firstName: 'María',
        lastName: 'Gómez',
        email: 'maria@test.local',
        tenantId,
      },
    });
    const addressId = randomUUID();
    await prisma.customerAddress.create({
      data: {
        id: addressId,
        customerId,
        tenantId,
        street: 'Av. Reforma',
        exteriorNumber: '123',
        zipCode: '06600',
        neighborhood: 'Juárez',
        municipality: 'Cuauhtémoc',
        city: 'CDMX',
        state: 'CDMX',
        label: 'Oficina',
      },
    });
    return { customerId, addressId };
  }

  /** Seed an eligible (PENDING + shipping address) sale with a folio. */
  async function seedEligibleSale(input: {
    addressId: string;
    customerId: string;
    folio: string;
  }): Promise<{ id: string }> {
    const cashierId = randomUUID();
    await prisma.user.create({
      data: {
        id: cashierId,
        email: `cashier-${randomUUID()}@test.local`,
        hashedPassword: 'test',
        name: 'Cashier',
        isActive: true,
      },
    });
    const saleId = randomUUID();
    await prisma.sale.create({
      data: {
        id: saleId,
        userId: cashierId,
        customerId: input.customerId,
        shippingAddressId: input.addressId,
        tenantId,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        folio: input.folio,
      },
    });
    return { id: saleId };
  }

  type RouteFixture = {
    route: DeliveryRoute;
    driverId: string;
    saleIds: string[];
    customerId: string;
    addressId: string;
  };

  /**
   * Create a DRAFT route for the baseline tenant (eligible-sale probe backed
   * by the seeded address) and persist it via the adapter. The route is
   * hydrated through `findById` on the reload inside `save()`.
   */
  async function seedDraftRoute(
    saleCount: number,
    notes?: string,
  ): Promise<RouteFixture> {
    const driver = await seedDriver();
    const { customerId, addressId } = await seedCustomerAndAddress();
    const seeded: string[] = [];
    for (let i = 0; i < saleCount; i++) {
      const sale = await seedEligibleSale({
        addressId,
        customerId,
        folio: `A-202608-${String(i + 1).padStart(6, '0')}`,
      });
      seeded.push(sale.id);
    }

    const route = await DeliveryRoute.create({
      id: randomUUID(),
      tenantId,
      driverUserId: driver.id,
      saleIds: seeded,
      notes,
      checkSaleEligibility: async (saleId): Promise<SaleEligibilitySnapshot | null> =>
        seeded.includes(saleId)
          ? { deliveryStatus: 'PENDING', shippingAddressId: addressId }
          : null,
    });
    await repo.save(route);
    return { route, driverId: driver.id, saleIds: seeded, customerId, addressId };
  }

  // ── Tenant scoping ─────────────────────────────────────────────────────

  describe('tenant scoping', () => {
    it('findById returns the aggregate for the owning tenant (round-trip with stops)', async () => {
      const { route, driverId, saleIds } = await seedDraftRoute(2, 'Nota');

      const found = await repo.findById({ tenantId, id: route.id });

      expect(found).not.toBeNull();
      expect(found?.id).toBe(route.id);
      expect(found?.tenantId).toBe(tenantId);
      expect(found?.driverUserId).toBe(driverId);
      expect(found?.status).toBe('DRAFT');
      expect(found?.notes).toBe('Nota');
      expect(found?.stops).toHaveLength(2);
      const stopSaleIds = found?.stops.map((s) => s.saleId);
      expect(stopSaleIds).toEqual(saleIds);
      // sortOrder 0..n-1 in create order.
      expect(found?.stops.map((s) => s.sortOrder)).toEqual([0, 1]);
    });

    it('findById returns null for a route that belongs to another tenant', async () => {
      const { route } = await seedDraftRoute(1);

      // Second tenant — real row so the "cross-tenant" semantics are
      // unambiguous (route exists in the DB, just not under tenant B).
      const foreignTenantId = randomUUID();
      await prisma.tenant.create({
        data: {
          id: foreignTenantId,
          name: 'Foreign Tenant',
          slug: `foreign-${randomUUID()}`,
          isActive: true,
        },
      });

      currentTenantId = foreignTenantId;
      try {
        const found = await repo.findById({ tenantId: foreignTenantId, id: route.id });
        expect(found).toBeNull();
      } finally {
        currentTenantId = tenantId;
      }
    });

    it('findOneWithStops returns null for a route that belongs to another tenant', async () => {
      const { route } = await seedDraftRoute(1);

      const foreignTenantId = randomUUID();
      await prisma.tenant.create({
        data: {
          id: foreignTenantId,
          name: 'Foreign Tenant',
          slug: `foreign-${randomUUID()}`,
          isActive: true,
        },
      });

      currentTenantId = foreignTenantId;
      try {
        const row = await repo.findOneWithStops({
          tenantId: foreignTenantId,
          id: route.id,
        });
        expect(row).toBeNull();
      } finally {
        currentTenantId = tenantId;
      }
    });
  });

  // ── findOneWithStops projection ────────────────────────────────────────

  describe('findOneWithStops projection shape', () => {
    it('returns the route with driver + stops carrying saleFolio, customer name and shipping address', async () => {
      const { route, driverId, saleIds, customerId, addressId } = await seedDraftRoute(2);

      const row = await repo.findOneWithStops({ tenantId, id: route.id });

      expect(row).not.toBeNull();
      expect(row?.id).toBe(route.id);
      expect(row?.tenantId).toBe(tenantId);
      expect(row?.driverUserId).toBe(driverId);
      expect(row?.status).toBe('DRAFT');

      // Driver projection.
      expect(row?.driver).toMatchObject({
        id: driverId,
        name: 'Juan Driver',
        email: expect.stringMatching(/^driver-/),
      });

      // Stops — ordered by sortOrder, with the read-model extras.
      expect(row?.stops).toHaveLength(2);
      const firstStop = row?.stops[0];
      expect(firstStop?.saleId).toBe(saleIds[0]);
      expect(firstStop?.saleFolio).toBe('A-202608-000001');
      expect(firstStop?.sortOrder).toBe(0);
      expect(firstStop?.status).toBe('PENDING');
      expect(firstStop?.checkedInAt).toBeNull();
      expect(firstStop?.completedAt).toBeNull();

      // Customer projection (name = firstName + lastName, trimmed).
      expect(firstStop?.customer).toEqual({
        id: customerId,
        name: 'María Gómez',
        email: 'maria@test.local',
      });

      // Shipping address projection — all wire fields.
      expect(firstStop?.shippingAddress).toEqual({
        id: addressId,
        street: 'Av. Reforma',
        exteriorNumber: '123',
        interiorNumber: null,
        zipCode: '06600',
        neighborhood: 'Juárez',
        municipality: 'Cuauhtémoc',
        city: 'CDMX',
        state: 'CDMX',
        label: 'Oficina',
      });

      expect(row?.stops[1]?.saleFolio).toBe('A-202608-000002');
      expect(row?.stops[1]?.sortOrder).toBe(1);
    });
  });

  // ── findDriverUserIdById ───────────────────────────────────────────────

  describe('findDriverUserIdById', () => {
    it('returns { driverUserId } for an existing route in the owning tenant', async () => {
      const { route, driverId } = await seedDraftRoute(1);

      const result = await repo.findDriverUserIdById({ tenantId, id: route.id });

      expect(result).toEqual({ driverUserId: driverId });
    });

    it('returns null for a missing route id', async () => {
      const result = await repo.findDriverUserIdById({
        tenantId,
        id: randomUUID(),
      });

      expect(result).toBeNull();
    });

    it('returns null for a route that belongs to another tenant', async () => {
      const { route } = await seedDraftRoute(1);

      const foreignTenantId = randomUUID();
      await prisma.tenant.create({
        data: {
          id: foreignTenantId,
          name: 'Foreign Tenant',
          slug: `foreign-${randomUUID()}`,
          isActive: true,
        },
      });

      currentTenantId = foreignTenantId;
      try {
        const result = await repo.findDriverUserIdById({
          tenantId: foreignTenantId,
          id: route.id,
        });
        expect(result).toBeNull();
      } finally {
        currentTenantId = tenantId;
      }
    });
  });

  // ── ADR-7 partial unique index (P2002 → 409 domain error) ──────────────

  describe('ADR-7 partial unique index conflict', () => {
    it('saving a second ACTIVE route that shares a sale maps P2002 to DeliveryRouteSaleAlreadyInActiveRouteError', async () => {
      const { route: routeA } = await seedDraftRoute(2);
      const sharedSaleId = routeA.stops[0].saleId;

      // Start route A → arms activeRouteId on every stop.
      routeA.start({});
      await repo.save(routeA);

      // Route B shares route A's first sale. Starting B arms its own
      // activeRouteId, and the partial unique index
      // (tenantId, saleId) WHERE activeRouteId IS NOT NULL raises P2002
      // on the stop createMany — mapped by the adapter to the 409 domain error.
      const driverB = await seedDriver();
      const routeB = await DeliveryRoute.create({
        id: randomUUID(),
        tenantId,
        driverUserId: driverB.id,
        saleIds: [sharedSaleId],
        checkSaleEligibility: async () => ({
          deliveryStatus: 'PENDING' as const,
          shippingAddressId: randomUUID(),
        }),
      });
      routeB.start({});

      const error = await repo.save(routeB).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteSaleAlreadyInActiveRouteError);
      expect((error as DeliveryRouteSaleAlreadyInActiveRouteError).code).toBe(
        'DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE',
      );
    });

    it('starting the SAME sale twice on the same route (duplicate) does not conflict — only cross-route duplicates do', async () => {
      // Sanity contrast: a single ACTIVE route saving its own stops is
      // NOT a conflict (the index is per (tenantId, saleId), and each sale
      // appears once per route).
      const { route } = await seedDraftRoute(2);
      route.start({});

      await expect(repo.save(route)).resolves.not.toBeNull();

      const persisted = await repo.findOneWithStops({ tenantId, id: route.id });
      expect(persisted?.status).toBe('ACTIVE');
      expect(persisted?.stops.every((s) => s.status === 'PENDING')).toBe(true);
    });
  });
});
