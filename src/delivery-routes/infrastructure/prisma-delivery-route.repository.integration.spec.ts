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
 *   5. `DeliveryRoutesService.checkInStop` — the FULL transaction (route/
 *      stop conditional commit + Sale mirror + next-stop/thank-you outbox
 *      rows) against real Postgres, including the real rollback of every
 *      write when a publish throws AFTER the thank-you row was inserted.
 *      The failure is a forced fault injection, NOT a real concurrent
 *      interleaving (stale CAS is covered by the unit specs).
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
import {
  DeliveryRoute,
  type SaleEligibilitySnapshot,
} from '../domain/delivery-route.entity';
import {
  DeliveryRouteInvalidTransitionError,
  DeliveryRouteSaleAlreadyInActiveRouteError,
} from '../domain/delivery-route.errors';
import { PrismaDeliveryRouteRepository } from './prisma-delivery-route.repository';
import { ManualRouteOptimizer } from './manual-route-optimizer';
import {
  DeliveryRoutesService,
  type DeliveryRouteRequestContext,
} from '../application/delivery-routes.service';
import { PrismaSaleRepository } from '../../sales/infrastructure/prisma-sale.repository';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import {
  DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE,
  DELIVERY_ROUTE_OUTBOX_AGGREGATE_TYPE,
} from '../outbox/delivery-route-outbox.types';
import { DELIVERY_THANK_YOU_OUTBOX_TYPE } from '../inngest/delivery-thank-you.event';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb('PrismaDeliveryRouteRepository (Integration - Real DB)', () => {
  let prisma: PrismaClient;
  let repo: PrismaDeliveryRouteRepository;
  let saleRepo: PrismaSaleRepository;
  let tenantPrisma: TenantPrismaService;
  let cls: ClsService<TenantClsStore>;
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

    // In-memory CLS shim. `get()` with no key must return the whole store
    // (`DeliveryRoutesService.requireTenantId` destructures it) and
    // `TenantPrismaService.runInTransaction` stores the ambient tx through
    // `set('prismaTxClient', tx)`, so the shim owns a mutable slot map.
    const txSlots = new Map<string, unknown>();
    cls = {
      get: (key?: string): unknown => {
        if (key === undefined) {
          return { tenantId: currentTenantId, isSuperAdmin: false };
        }
        if (key === 'tenantId') return currentTenantId;
        if (key === 'isSuperAdmin') return false;
        return txSlots.get(key);
      },
      set: (key: string, value: unknown): void => {
        txSlots.set(key, value);
      },
    } as unknown as ClsService<TenantClsStore>;

    tenantPrisma = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls,
    );
    repo = new PrismaDeliveryRouteRepository(tenantPrisma);
    saleRepo = new PrismaSaleRepository(tenantPrisma);
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
  async function seedDriver(): Promise<{
    id: string;
    name: string;
    email: string;
  }> {
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
      checkSaleEligibility: async (
        saleId,
      ): Promise<SaleEligibilitySnapshot | null> =>
        seeded.includes(saleId)
          ? { deliveryStatus: 'PENDING', shippingAddressId: addressId }
          : null,
    });
    await repo.save(route);
    return {
      route,
      driverId: driver.id,
      saleIds: seeded,
      customerId,
      addressId,
    };
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
        const found = await repo.findById({
          tenantId: foreignTenantId,
          id: route.id,
        });
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
      const { route, driverId, saleIds, customerId, addressId } =
        await seedDraftRoute(2);

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

      const result = await repo.findDriverUserIdById({
        tenantId,
        id: route.id,
      });

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

  // ── checkInStop — real transaction against PostgreSQL ─────────────────

  describe('checkInStop (real transaction)', () => {
    const ctx = {
      userId: randomUUID(),
      ability: { can: () => true },
    } as unknown as DeliveryRouteRequestContext;

    function buildService(
      outboxWriter: OutboxWriterService = new OutboxWriterService(),
    ): DeliveryRoutesService {
      return new DeliveryRoutesService(
        repo,
        saleRepo,
        new ManualRouteOptimizer(),
        tenantPrisma,
        cls,
        outboxWriter,
      );
    }

    /** Seed a DRAFT route, start it, and return its persisted identities. */
    async function seedActiveRoute(): Promise<{
      route: DeliveryRoute;
      saleIds: string[];
      stopIds: string[];
    }> {
      const { route, saleIds } = await seedDraftRoute(2);
      route.start({});
      await repo.save(route);
      return { route, saleIds, stopIds: route.stops.map((stop) => stop.id) };
    }

    function outboxRowsForRoute(routeId: string) {
      return prisma.outboxEvent.findMany({ where: { aggregateId: routeId } });
    }

    function deliveryStatusOf(saleId: string) {
      return prisma.sale.findUnique({
        where: { id: saleId },
        select: { deliveryStatus: true },
      });
    }

    it('first of 2 stops emits next-stop + ids-only thank-you rows and marks the sale DELIVERED; a replay emits none; the last stop emits thank-you only and COMPLETES the route', async () => {
      const service = buildService();
      const { route, saleIds, stopIds } = await seedActiveRoute();

      await service.checkInStop(ctx, route.id, stopIds[0]);

      const afterFirst = await outboxRowsForRoute(route.id);
      expect(afterFirst).toHaveLength(2);
      const nextStopRow = afterFirst.find(
        (row) => row.eventType === DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE,
      );
      const thankYouRow = afterFirst.find(
        (row) => row.eventType === DELIVERY_THANK_YOU_OUTBOX_TYPE,
      );
      expect(nextStopRow).toMatchObject({
        tenantId,
        aggregateType: DELIVERY_ROUTE_OUTBOX_AGGREGATE_TYPE,
        aggregateId: route.id,
      });
      expect(nextStopRow?.payload).toMatchObject({
        tenantId,
        routeId: route.id,
        currentStopId: stopIds[0],
        nextStopId: stopIds[1],
        nextSaleId: saleIds[1],
      });
      expect(thankYouRow).toMatchObject({
        tenantId,
        aggregateType: DELIVERY_ROUTE_OUTBOX_AGGREGATE_TYPE,
        aggregateId: route.id,
      });
      // Ids-only payload: exactly the four identities, nothing else.
      expect(thankYouRow?.payload).toEqual({
        tenantId,
        saleId: saleIds[0],
        routeId: route.id,
        stopId: stopIds[0],
      });
      expect(await deliveryStatusOf(saleIds[0])).toEqual({
        deliveryStatus: 'DELIVERED',
      });
      expect(await deliveryStatusOf(saleIds[1])).toEqual({
        deliveryStatus: 'PENDING',
      });

      const midRoute = await repo.findById({ tenantId, id: route.id });
      expect(midRoute?.status).toBe('ACTIVE');
      expect(midRoute?.completedAt).toBeNull();
      expect(midRoute?.stops.map((stop) => stop.status)).toEqual([
        'COMPLETED',
        'PENDING',
      ]);

      // Duplicate replay — no second outbox row for the same winning stop.
      await service.checkInStop(ctx, route.id, stopIds[0]);
      expect(await outboxRowsForRoute(route.id)).toHaveLength(2);
      const replayed = await repo.findById({ tenantId, id: route.id });
      expect(replayed?.status).toBe('ACTIVE');

      // Last stop — thank-you only, route auto-completes.
      await service.checkInStop(ctx, route.id, stopIds[1]);
      const afterLast = await outboxRowsForRoute(route.id);
      expect(afterLast).toHaveLength(3);
      expect(
        afterLast.filter(
          (row) => row.eventType === DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE,
        ),
      ).toHaveLength(1);
      const thankYouRows = afterLast.filter(
        (row) => row.eventType === DELIVERY_THANK_YOU_OUTBOX_TYPE,
      );
      expect(thankYouRows).toHaveLength(2);
      expect(thankYouRows.map((row) => row.payload)).toEqual(
        expect.arrayContaining([
          {
            tenantId,
            saleId: saleIds[0],
            routeId: route.id,
            stopId: stopIds[0],
          },
          {
            tenantId,
            saleId: saleIds[1],
            routeId: route.id,
            stopId: stopIds[1],
          },
        ]),
      );
      expect(await deliveryStatusOf(saleIds[1])).toEqual({
        deliveryStatus: 'DELIVERED',
      });

      const completed = await repo.findById({ tenantId, id: route.id });
      expect(completed?.status).toBe('COMPLETED');
      expect(completed?.completedAt).not.toBeNull();
      expect(completed?.stops.map((stop) => stop.status)).toEqual([
        'COMPLETED',
        'COMPLETED',
      ]);
      const activeMarkers = completed?.stops.map((stop) => stop.activeRouteId);
      expect(activeMarkers).toEqual([null, null]);
    });

    it('rolls back the route/stop commit, the sale mirror and BOTH real outbox rows when a publish throws after the thank-you insert', async () => {
      const realWriter = new OutboxWriterService();
      const attemptedEventTypes: string[] = [];
      const faultInjectingWriter = {
        publish: async (
          ...args: Parameters<OutboxWriterService['publish']>
        ): Promise<void> => {
          await realWriter.publish(...args);
          attemptedEventTypes.push(args[4]);
          if (args[4] === DELIVERY_THANK_YOU_OUTBOX_TYPE) {
            throw new Error('simulated failure after thank-you insert');
          }
        },
      } as unknown as OutboxWriterService;
      const service = buildService(faultInjectingWriter);
      const { route, saleIds, stopIds } = await seedActiveRoute();

      await expect(
        service.checkInStop(ctx, route.id, stopIds[0]),
      ).rejects.toThrow('simulated failure after thank-you insert');

      // Both real inserts ran inside the transaction before the throw...
      expect(attemptedEventTypes).toEqual([
        DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE,
        DELIVERY_THANK_YOU_OUTBOX_TYPE,
      ]);
      // ...yet PostgreSQL rolled the whole attempt back.
      expect(await outboxRowsForRoute(route.id)).toHaveLength(0);
      const rolledBack = await repo.findById({ tenantId, id: route.id });
      expect(rolledBack?.status).toBe('ACTIVE');
      expect(rolledBack?.completedAt).toBeNull();
      expect(rolledBack?.stops.map((stop) => stop.status)).toEqual([
        'PENDING',
        'PENDING',
      ]);
      expect(rolledBack?.stops[0]?.checkedInAt).toBeNull();
      expect(await deliveryStatusOf(saleIds[0])).toEqual({
        deliveryStatus: 'PENDING',
      });
    });

    it('rejects a check-in on a cancelled route and writes nothing', async () => {
      const service = buildService();
      const { route, saleIds, stopIds } = await seedActiveRoute();

      await service.cancel(ctx, route.id);

      await expect(
        service.checkInStop(ctx, route.id, stopIds[0]),
      ).rejects.toBeInstanceOf(DeliveryRouteInvalidTransitionError);

      expect(await outboxRowsForRoute(route.id)).toHaveLength(0);
      const cancelled = await repo.findById({ tenantId, id: route.id });
      expect(cancelled?.status).toBe('CANCELLED');
      expect(cancelled?.stops.map((stop) => stop.status)).toEqual([
        'PENDING',
        'PENDING',
      ]);
      expect(await deliveryStatusOf(saleIds[0])).toEqual({
        deliveryStatus: 'PENDING',
      });
    });
  });
});
