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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
        latitude: null,
        longitude: null,
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

  describe('ADR-7 partial unique index conflict (S2 reservation)', () => {
    it('saving a DRAFT route that appends a sale already reserved by an ACTIVE route maps to the 409 domain error and rolls back BOTH routes', async () => {
      const { route: routeA } = await seedDraftRoute(1);
      // Start route A → arms the reservation on every stop.
      routeA.start({});
      await repo.save(routeA);
      const sharedSaleId = routeA.stops[0].saleId;

      // Route B is a DRAFT route with its OWN eligible sale, so it is valid
      // state (its own reservation) and persists.
      const { route: routeB, addressId } = await seedDraftRoute(1);
      const routeBSaleId = routeB.stops[0].saleId;
      expect(routeBSaleId).not.toBe(sharedSaleId);

      const beforeA = await repo.findOneWithStops({ tenantId, id: routeA.id });
      const beforeB = await repo.findOneWithStops({ tenantId, id: routeB.id });
      expect(beforeA?.status).toBe('ACTIVE');
      expect(beforeB?.status).toBe('DRAFT');

      // Attempt to append the sale route A already reserves. The
      // reservation conflict is detected INSIDE the save transaction, so
      // route B's upsert + full stop replacement roll back together (T1
      // atomicity) and neither read model changes.
      await routeB.addStop({
        saleId: sharedSaleId,
        checkSaleEligibility: async () => ({
          deliveryStatus: 'PENDING' as const,
          shippingAddressId: addressId,
        }),
      });

      const error = await repo.save(routeB).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteSaleAlreadyInActiveRouteError);
      expect((error as DeliveryRouteSaleAlreadyInActiveRouteError).code).toBe(
        'DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE',
      );
      expect(
        (error as DeliveryRouteSaleAlreadyInActiveRouteError).details,
      ).toMatchObject({
        reason: 'SALE_ALREADY_RESERVED',
        routeId: routeB.id,
        conflictSaleIds: [sharedSaleId],
      });

      const afterA = await repo.findOneWithStops({ tenantId, id: routeA.id });
      const afterB = await repo.findOneWithStops({ tenantId, id: routeB.id });
      expect(afterA).toEqual(beforeA);
      // Compare the complete read model so a rejected write cannot silently
      // change status, timestamps, stop identities, ordering, or projection.
      expect(afterB).toEqual(beforeB);
    });

    it('saving a second DRAFT route that claims a sale already reserved by another DRAFT route is rejected — the reservation is armed at assignment', async () => {
      const { route: routeA, saleIds } = await seedDraftRoute(1);
      const sharedSaleId = saleIds[0];
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

      const error = await repo.save(routeB).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteSaleAlreadyInActiveRouteError);
      expect(
        (error as DeliveryRouteSaleAlreadyInActiveRouteError).details,
      ).toMatchObject({ conflictSaleIds: [sharedSaleId] });

      // The rejected DRAFT route never persisted; the holder is untouched
      // and still owns the reservation.
      expect(
        await repo.findOneWithStops({ tenantId, id: routeB.id }),
      ).toBeNull();
      const foundA = await repo.findById({ tenantId, id: routeA.id });
      expect(foundA?.status).toBe('DRAFT');
      expect(foundA?.stops.map((stop) => stop.saleId)).toEqual([sharedSaleId]);
      expect(foundA?.stops[0].activeRouteId).toBe(routeA.id);
    });

    it('rolls back the parent upsert and the stop replacement when the createMany hits a real unique conflict beyond the pre-check', async () => {
      const { route, saleIds } = await seedDraftRoute(1);
      const before = await repo.findOneWithStops({ tenantId, id: route.id });
      expect(before?.stops).toHaveLength(1);

      // `addStop` does not dedupe, so appending the route's OWN sale makes
      // the createMany insert two stops for the same (tenantId, saleId) with
      // an armed reservation. The save pre-check cannot see an
      // intra-statement duplicate, so the ADR-7 partial unique index fails
      // the createMany AFTER the parent upsert and the deleteMany already
      // ran — the recreate-stage rollback a pre-check rejection cannot
      // prove.
      await route.addStop({
        saleId: saleIds[0],
        checkSaleEligibility: async () => ({
          deliveryStatus: 'PENDING' as const,
          shippingAddressId: randomUUID(),
        }),
      });

      const error = await repo.save(route).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DeliveryRouteSaleAlreadyInActiveRouteError);
      expect(
        (error as DeliveryRouteSaleAlreadyInActiveRouteError).details,
      ).toMatchObject({
        reason: 'PARTIAL_UNIQUE_INDEX_VIOLATION',
        routeId: route.id,
        conflictSaleIds: [],
      });

      // The parent upsert (incl. updatedAt) and the deleteMany must have
      // rolled back together: the complete read model is the pre-attempt
      // state, and the original single stop row survives.
      const after = await repo.findOneWithStops({ tenantId, id: route.id });
      expect(after).toEqual(before);
      const persistedStops = await prisma.deliveryRouteStop.findMany({
        where: { routeId: route.id },
        select: { saleId: true, activeRouteId: true },
      });
      expect(persistedStops).toEqual([
        { saleId: saleIds[0], activeRouteId: route.id },
      ]);
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

  // ── transferStop — explicit DRAFT→DRAFT move (S3) ────────────────────

  describe('transferStop (real transaction)', () => {
    const ctx = {
      userId: randomUUID(),
      ability: { can: () => true },
    } as unknown as DeliveryRouteRequestContext;

    const makeService = () =>
      new DeliveryRoutesService(
        repo,
        saleRepo,
        new ManualRouteOptimizer(),
        tenantPrisma,
        cls,
        new OutboxWriterService(),
      );

    it('moves the stop between two DRAFT routes, releases the origin reservation and arms the destination, and refuses to start an emptied origin', async () => {
      const { route: origin } = await seedDraftRoute(1);
      const { route: destination } = await seedDraftRoute(1);
      const movedSaleId = origin.stops[0].saleId;
      const movedStopId = origin.stops[0].id;
      const destinationSaleId = destination.stops[0].saleId;
      const service = makeService();

      const result = await service.transferStop(ctx, origin.id, movedStopId, {
        destinationRouteId: destination.id,
      });

      // Response carries both committed routes.
      expect(result.originRoute.stops).toHaveLength(0);
      expect(result.destinationRoute.stops.map((stop) => stop.saleId)).toEqual([
        destinationSaleId,
        movedSaleId,
      ]);

      // Persisted state: the stop left the origin and is last in the
      // destination, reserved by the destination.
      const persistedOrigin = await repo.findById({
        tenantId,
        id: origin.id,
      });
      expect(persistedOrigin?.status).toBe('DRAFT');
      expect(persistedOrigin?.stops).toHaveLength(0);
      const persistedDestination = await repo.findById({
        tenantId,
        id: destination.id,
      });
      expect(persistedDestination?.stops.map((stop) => stop.saleId)).toEqual([
        destinationSaleId,
        movedSaleId,
      ]);
      expect(
        persistedDestination?.stops.find((stop) => stop.saleId === movedSaleId)
          ?.activeRouteId,
      ).toBe(destination.id);

      // The sale is reserved by EXACTLY ONE DRAFT/ACTIVE route — never both.
      const reservations = await prisma.deliveryRouteStop.findMany({
        where: {
          tenantId,
          saleId: movedSaleId,
          activeRouteId: { not: null },
        },
        select: { routeId: true },
      });
      expect(reservations).toEqual([{ routeId: destination.id }]);

      // An emptied DRAFT origin is allowed but cannot be started.
      await expect(service.start(ctx, origin.id)).rejects.toBeInstanceOf(
        DeliveryRouteInvalidTransitionError,
      );
    });
  });

  // ── transferStop vs start — real lock serialization (two isolated ctx) ─
  //
  // Proven with TWO independent Prisma/CLS contexts: a shared CLS `tx` slot
  // (the Map in `beforeAll`) would let the two ambient-transaction pointers
  // collide. The winner's repository is wrapped so it acquires the real
  // `FOR UPDATE` row locks and then BLOCKS on a test-controlled barrier,
  // holding its transaction open. The loser is launched afterwards and can
  // therefore never acquire the locks first: it blocks behind the winner at
  // the DATABASE level and only proceeds after the winner commits. The
  // barrier is released in `finally` and every await is bounded, so a broken
  // race fails loudly instead of leaking an open transaction.

  describe('transferStop vs start — lock serialization (two isolated contexts)', () => {
    const RACE_TIMEOUT_MS = 10_000;
    const raceCtx = {
      userId: randomUUID(),
      ability: { can: () => true },
    } as unknown as DeliveryRouteRequestContext;

    /** Reject a bounded await so a broken race fails instead of hanging. */
    async function withTimeout<T>(
      promise: Promise<T>,
      label: string,
    ): Promise<T> {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`race timeout: ${label}`)),
              RACE_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    /**
     * Barrier that holds the WINNER's route locks open until `release()` —
     * deterministic DB-level ordering with no sleep timing.
     */
    function createLockHoldBarrier(): {
      acquired: Promise<void>;
      released: Promise<void>;
      signalAcquired: () => void;
      release: () => void;
    } {
      let signalAcquired!: () => void;
      const acquired = new Promise<void>((resolve) => {
        signalAcquired = resolve;
      });
      let signalRelease!: () => void;
      const released = new Promise<void>((resolve) => {
        signalRelease = resolve;
      });
      return {
        acquired,
        released,
        signalAcquired,
        release: () => signalRelease(),
      };
    }

    /**
     * Real repository subclass whose row-lock acquisition holds the winner's
     * transaction open until the barrier releases it.
     */
    class BarrierAwareDeliveryRouteRepository extends PrismaDeliveryRouteRepository {
      constructor(
        tenantPrisma: TenantPrismaService,
        private readonly barrier: {
          signalAcquired: () => void;
          released: Promise<void>;
        },
      ) {
        super(tenantPrisma);
      }

      override async lockRoutesForUpdate(
        input: Parameters<
          PrismaDeliveryRouteRepository['lockRoutesForUpdate']
        >[0],
      ): Promise<string[]> {
        const missing = await super.lockRoutesForUpdate(input);
        this.barrier.signalAcquired();
        await this.barrier.released;
        return missing;
      }
    }

    /** A fully isolated Prisma/CLS/repo/service context. */
    function makeIsolatedContext(barrier?: {
      signalAcquired: () => void;
      released: Promise<void>;
    }) {
      const txSlots = new Map<string, unknown>();
      const isolatedCls = {
        get: (key?: string): unknown => {
          if (key === undefined) return { tenantId, isSuperAdmin: false };
          if (key === 'tenantId') return tenantId;
          if (key === 'isSuperAdmin') return false;
          return txSlots.get(key);
        },
        set: (key: string, value: unknown): void => {
          txSlots.set(key, value);
        },
      } as unknown as ClsService<TenantClsStore>;
      const isolatedTenantPrisma = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        isolatedCls,
      );
      const isolatedRepo = barrier
        ? new BarrierAwareDeliveryRouteRepository(isolatedTenantPrisma, barrier)
        : new PrismaDeliveryRouteRepository(isolatedTenantPrisma);
      const service = new DeliveryRoutesService(
        isolatedRepo,
        new PrismaSaleRepository(isolatedTenantPrisma),
        new ManualRouteOptimizer(),
        isolatedTenantPrisma,
        isolatedCls,
        new OutboxWriterService(),
      );
      return { service };
    }

    function outcome<T>(promise: Promise<T>) {
      return promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    }

    function reservationsOf(saleId: string) {
      return prisma.deliveryRouteStop.findMany({
        where: { tenantId, saleId, activeRouteId: { not: null } },
        select: { routeId: true },
      });
    }

    it('start wins: the concurrent transfer observes the committed ACTIVE origin and rejects unchanged', async () => {
      const { route: origin } = await seedDraftRoute(1);
      const { route: destination } = await seedDraftRoute(1);
      const movedSaleId = origin.stops[0].saleId;
      const movedStopId = origin.stops[0].id;

      const barrier = createLockHoldBarrier();
      const winner = makeIsolatedContext(barrier); // start
      const contender = makeIsolatedContext(); // transferStop

      const beforeDestination = await repo.findOneWithStops({
        tenantId,
        id: destination.id,
      });

      const startPromise = outcome(winner.service.start(raceCtx, origin.id));
      await withTimeout(barrier.acquired, 'winner acquired origin lock');
      const transferPromise = outcome(
        contender.service.transferStop(raceCtx, origin.id, movedStopId, {
          destinationRouteId: destination.id,
        }),
      );
      barrier.release();

      try {
        const startResult = await withTimeout(startPromise, 'start settles');
        expect(startResult.ok).toBe(true);
        expect(startResult.ok && startResult.value.status).toBe('ACTIVE');

        const transferResult = await withTimeout(
          transferPromise,
          'transfer settles',
        );
        expect(transferResult.ok).toBe(false);
        if (!transferResult.ok) {
          expect(transferResult.error).toBeInstanceOf(
            DeliveryRouteInvalidTransitionError,
          );
          expect(
            (transferResult.error as DeliveryRouteInvalidTransitionError).code,
          ).toBe('DELIVERY_ROUTE_INVALID_TRANSITION');
        }
      } finally {
        barrier.release();
      }

      const afterOrigin = await repo.findOneWithStops({
        tenantId,
        id: origin.id,
      });
      const afterDestination = await repo.findOneWithStops({
        tenantId,
        id: destination.id,
      });

      // The rejected transfer changed NEITHER route: the origin keeps its
      // single stop (now reserved by the ACTIVE origin) and the destination
      // is byte-for-byte the pre-race read model.
      expect(afterDestination).toEqual(beforeDestination);
      expect(afterOrigin?.status).toBe('ACTIVE');
      expect(afterOrigin?.stops.map((stop) => stop.saleId)).toEqual([
        movedSaleId,
      ]);
      expect(afterOrigin?.stops.map((stop) => stop.id)).toEqual([movedStopId]);
      expect(await reservationsOf(movedSaleId)).toEqual([
        { routeId: origin.id },
      ]);
    });

    it('transfer wins: the concurrent start observes the emptied origin and rejects with EMPTY_ROUTE; the moved sale is reserved only by the destination', async () => {
      const { route: origin } = await seedDraftRoute(1);
      const { route: destination } = await seedDraftRoute(1);
      const movedSaleId = origin.stops[0].saleId;
      const movedStopId = origin.stops[0].id;
      const destinationSaleId = destination.stops[0].saleId;

      const barrier = createLockHoldBarrier();
      const winner = makeIsolatedContext(barrier); // transferStop
      const contender = makeIsolatedContext(); // start

      const transferPromise = outcome(
        winner.service.transferStop(raceCtx, origin.id, movedStopId, {
          destinationRouteId: destination.id,
        }),
      );
      await withTimeout(barrier.acquired, 'winner acquired route locks');
      const startPromise = outcome(contender.service.start(raceCtx, origin.id));
      barrier.release();

      try {
        const transferResult = await withTimeout(
          transferPromise,
          'transfer settles',
        );
        expect(transferResult.ok).toBe(true);

        const startResult = await withTimeout(startPromise, 'start settles');
        expect(startResult.ok).toBe(false);
        if (!startResult.ok) {
          expect(startResult.error).toBeInstanceOf(
            DeliveryRouteInvalidTransitionError,
          );
          expect(
            (startResult.error as DeliveryRouteInvalidTransitionError).code,
          ).toBe('DELIVERY_ROUTE_INVALID_TRANSITION');
          expect(
            (startResult.error as DeliveryRouteInvalidTransitionError).details,
          ).toMatchObject({ reason: 'EMPTY_ROUTE' });
        }
      } finally {
        barrier.release();
      }

      const afterOrigin = await repo.findOneWithStops({
        tenantId,
        id: origin.id,
      });
      const afterDestination = await repo.findOneWithStops({
        tenantId,
        id: destination.id,
      });

      // `start` observed the COMMITTED transfer: the origin is an empty
      // DRAFT and the moved sale is reserved by the destination ONLY.
      expect(afterOrigin?.status).toBe('DRAFT');
      expect(afterOrigin?.stops).toHaveLength(0);
      expect(afterDestination?.stops.map((stop) => stop.saleId)).toEqual([
        destinationSaleId,
        movedSaleId,
      ]);
      expect(await reservationsOf(movedSaleId)).toEqual([
        { routeId: destination.id },
      ]);
    });
  });

  // ── reservation migration guard (fixtures only) ──────────────────────

  describe('reservation migration guard (fixtures only)', () => {
    const migrationSql = () =>
      readFileSync(
        resolve(
          process.cwd(),
          'prisma/migrations/20261007221500_reserve_draft_delivery_route_sales/migration.sql',
        ),
        'utf8',
      );

    /** Insert a route row directly, bypassing the adapter (legacy shape). */
    async function seedLegacyRoute(
      status: 'DRAFT' | 'ACTIVE',
      driverId: string,
    ): Promise<string> {
      const id = randomUUID();
      await prisma.deliveryRoute.create({
        data: {
          id,
          tenantId,
          driverUserId: driverId,
          status,
          startedAt: status === 'ACTIVE' ? new Date() : null,
        },
      });
      return id;
    }

    /** Insert a stop row with an explicit (possibly NULL) marker. */
    async function seedLegacyStop(input: {
      routeId: string;
      saleId: string;
      sortOrder: number;
      activeRouteId: string | null;
    }): Promise<string> {
      const id = randomUUID();
      await prisma.deliveryRouteStop.create({
        data: {
          id,
          tenantId,
          routeId: input.routeId,
          saleId: input.saleId,
          sortOrder: input.sortOrder,
          status: 'PENDING',
          activeRouteId: input.activeRouteId,
        },
      });
      return id;
    }

    it('refuses to backfill when one sale is claimed by two DRAFT routes, choosing no owner and changing nothing', async () => {
      const driver = await seedDriver();
      const { customerId, addressId } = await seedCustomerAndAddress();
      const sale = await seedEligibleSale({
        addressId,
        customerId,
        folio: 'LEGACY-DUP',
      });
      const routeA = await seedLegacyRoute('DRAFT', driver.id);
      const routeB = await seedLegacyRoute('DRAFT', driver.id);
      const stopA = await seedLegacyStop({
        routeId: routeA,
        saleId: sale.id,
        sortOrder: 0,
        activeRouteId: null,
      });
      const stopB = await seedLegacyStop({
        routeId: routeB,
        saleId: sale.id,
        sortOrder: 0,
        activeRouteId: null,
      });

      await expect(prisma.$executeRawUnsafe(migrationSql())).rejects.toThrow(
        /refusing to backfill/,
      );

      const rows = await prisma.deliveryRouteStop.findMany({
        where: { id: { in: [stopA, stopB] } },
        select: { activeRouteId: true },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.activeRouteId)).toEqual([null, null]);
    });

    it('backfills the reservation for an existing DRAFT stop and leaves ACTIVE markers untouched', async () => {
      const driver = await seedDriver();
      const { customerId, addressId } = await seedCustomerAndAddress();
      const draftSale = await seedEligibleSale({
        addressId,
        customerId,
        folio: 'LEGACY-DRAFT',
      });
      const activeSale = await seedEligibleSale({
        addressId,
        customerId,
        folio: 'LEGACY-ACTIVE',
      });
      const draftRoute = await seedLegacyRoute('DRAFT', driver.id);
      const activeRoute = await seedLegacyRoute('ACTIVE', driver.id);
      const draftStop = await seedLegacyStop({
        routeId: draftRoute,
        saleId: draftSale.id,
        sortOrder: 0,
        activeRouteId: null,
      });
      const activeStop = await seedLegacyStop({
        routeId: activeRoute,
        saleId: activeSale.id,
        sortOrder: 0,
        activeRouteId: activeRoute,
      });

      await prisma.$executeRawUnsafe(migrationSql());

      const rows = await prisma.deliveryRouteStop.findMany({
        where: { id: { in: [draftStop, activeStop] } },
        select: { id: true, activeRouteId: true },
      });
      const markerById = new Map(
        rows.map((row) => [row.id, row.activeRouteId]),
      );
      expect(markerById.get(draftStop)).toBe(draftRoute);
      expect(markerById.get(activeStop)).toBe(activeRoute);
    });
  });
});
