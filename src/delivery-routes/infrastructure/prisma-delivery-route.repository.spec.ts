/**
 * ADAPTER UNIT SPEC: PrismaDeliveryRouteRepository.commitTransition —
 * delivery-routes / ODD O1.
 *
 * The conditional check-in / cancel seam is proven against a STATEFUL
 * in-memory Prisma double that evaluates the real `where` predicates and
 * mutates real rows, so these specs reproduce stale snapshots and
 * interleavings (a competing writer committing between the caller's load
 * and its commit) instead of mocks that always return the desired result.
 *
 * ODD O1 extends the same double to the nested read seam: the
 * `stops.include.where` clause of `findOneWithStops` and `list` is
 * EXECUTED (never ignored), and both reads are additionally asserted
 * structurally so a double that skipped relation filters could not
 * conceal a regression.
 *
 * Scope note: this proves source-level, in-memory predicate behavior only.
 * No PostgreSQL isolation, contention, row-lock or rollback behavior is
 * exercised or claimed here; `pnpm test` never reaches a database.
 */
import { Prisma } from '@prisma/client';
import { PrismaDeliveryRouteRepository } from './prisma-delivery-route.repository';
import { DeliveryRoute } from '../domain/delivery-route.entity';
import { captureRouteTransitionExpectation } from '../application/delivery-routes.service';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import type { DeliveryRouteReadModel } from '../domain/delivery-route.repository';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
const DRIVER_ID = 'driver-1';
const NOW = new Date('2026-08-01T12:00:00.000Z');
const LATER = new Date('2026-08-01T12:05:00.000Z');

// ── Stateful Prisma double ─────────────────────────────────────────────

type Predicate = Record<string, unknown>;

/** Nested `stops` include options the double understands. Anything else is
 *  rejected at execution time rather than silently dropped. */
type StopInclude = {
  where?: Predicate;
  orderBy?: { sortOrder?: 'asc' | 'desc' };
  /** ODD O1 (delete stop precondition) — the one-row probe cap is EXECUTED,
   *  so a probe asking for a single row cannot be satisfied by more. */
  take?: number;
  include?: unknown;
};

type RouteInclude = { driver?: unknown; stops?: true | StopInclude };

type RouteRow = {
  id: string;
  tenantId: string;
  driverUserId: string;
  status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type StopRow = {
  id: string;
  tenantId: string;
  routeId: string;
  saleId: string;
  sortOrder: number;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';
  checkedInAt: Date | null;
  completedAt: Date | null;
  skippedReason: string | null;
  activeRouteId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Nested to-one graph the double resolves for `stops.include.sale`. */
type SaleRow = {
  id: string;
  tenantId: string;
  folio: string | null;
  customerId: string | null;
  shippingAddressId: string | null;
};

type CustomerRow = {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
};

type AddressRow = {
  id: string;
  tenantId: string;
  street: string | null;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  label: string | null;
};

/** A stop row after its nested `sale` relation has been resolved. */
type ProjectedStopRow = StopRow & {
  sale?: Record<string, unknown> | null;
};

/** Field-level predicate evaluation. Throws on an operator this double does
 *  not implement, so an unnoticed new predicate shape fails loudly. */
const matchesField = (value: unknown, condition: unknown): boolean => {
  if (condition === null) return value === null;
  if (condition instanceof Date) {
    return value instanceof Date && value.getTime() === condition.getTime();
  }
  if (typeof condition === 'object') {
    const nested = condition as Record<string, unknown>;
    if ('in' in nested) {
      return (nested.in as unknown[]).includes(value);
    }
    if ('not' in nested) {
      return value !== nested.not;
    }
    throw new Error(
      `FakePrismaTransactionClient: unsupported predicate ${JSON.stringify(
        nested,
      )}`,
    );
  }
  return value === condition;
};

const matchesWhere = (
  row: Record<string, unknown>,
  where: Predicate,
): boolean =>
  Object.entries(where).every(([field, condition]) =>
    matchesField(row[field], condition),
  );

class FakePrismaTransactionClient {
  routes: RouteRow[] = [];
  stops: StopRow[] = [];
  sales: SaleRow[] = [];
  customers: CustomerRow[] = [];
  addresses: AddressRow[] = [];

  readonly routeUpdates: Predicate[] = [];
  readonly stopUpdates: Predicate[] = [];
  readonly stopCounts: Predicate[] = [];
  readonly routeReads: Predicate[] = [];
  /** Raw `include` argument of every route read, so a spec can assert the
   *  nested stop relation is explicitly tenant-qualified. */
  readonly routeIncludes: unknown[] = [];
  /** Raw `where` / `include` of every `deliveryRoute.findMany` (the `list`
   *  read), kept apart from the single-route arrays above. */
  readonly routeListWhere: Predicate[] = [];
  readonly routeListIncludes: unknown[] = [];

  /** Execute a nested `stops` include the way Prisma does: the rows are
   *  joined on `routeId`, THEN filtered by the nested `where` (executed,
   *  never ignored), THEN ordered, THEN capped by `take`. Any other nested
   *  option throws so a new one cannot silently bypass the predicate. */
  private nestedStops(
    row: RouteRow,
    include: true | StopInclude,
  ): ProjectedStopRow[] {
    if (include !== true) {
      const unsupported = Object.keys(include).filter(
        (key) =>
          key !== 'where' &&
          key !== 'orderBy' &&
          key !== 'take' &&
          key !== 'include',
      );
      if (unsupported.length > 0) {
        throw new Error(
          `FakePrismaTransactionClient: unsupported stop include option(s) ${unsupported.join(
            ', ',
          )}`,
        );
      }
    }
    const stopWhere = include === true ? undefined : include.where;
    const inTenantScope = (stop: StopRow): boolean =>
      stopWhere === undefined
        ? true
        : matchesWhere(stop as unknown as Record<string, unknown>, stopWhere);
    const stops = this.stops
      .filter((stop) => stop.routeId === row.id)
      .filter(inTenantScope)
      .map((stop) => this.projectStop(stop, include));
    const direction = include === true ? undefined : include.orderBy?.sortOrder;
    let ordered: ProjectedStopRow[];
    if (direction === 'asc') {
      ordered = stops.sort((a, b) => a.sortOrder - b.sortOrder);
    } else if (direction === 'desc') {
      ordered = stops.sort((a, b) => b.sortOrder - a.sortOrder);
    } else if (direction !== undefined) {
      throw new Error(
        `FakePrismaTransactionClient: unsupported stop orderBy ${JSON.stringify(
          include === true ? null : include.orderBy,
        )}`,
      );
    } else {
      ordered = stops;
    }
    // `take` is applied AFTER ordering, exactly like Prisma. A one-row probe
    // therefore returns one row, never the whole tenant stop set.
    const take = include === true ? undefined : include.take;
    if (take === undefined) return ordered;
    if (!Number.isInteger(take) || take < 0) {
      throw new Error(
        `FakePrismaTransactionClient: unsupported stop take ${JSON.stringify(
          take,
        )}`,
      );
    }
    return ordered.slice(0, take);
  }

  /** Resolve a stop's nested `sale` relation the way Prisma does. The raw
   *  `select` is HONORED: only the selected scalars come back, so a read
   *  whose nested select forgot `tenantId` cannot be rescued by this
   *  double. */
  private projectStop(
    stop: StopRow,
    include: true | StopInclude,
  ): ProjectedStopRow {
    const projected: ProjectedStopRow = { ...stop };
    if (include === true || include.include === undefined) return projected;
    const nested = include.include as {
      sale?: { select?: Record<string, unknown> };
    };
    const unsupported = Object.keys(nested).filter((key) => key !== 'sale');
    if (unsupported.length > 0) {
      throw new Error(
        `FakePrismaTransactionClient: unsupported stop nested relation(s) ${unsupported.join(
          ', ',
        )}`,
      );
    }
    if (!nested.sale) return projected;
    const sale = this.sales.find((candidate) => candidate.id === stop.saleId);
    projected.sale = sale
      ? this.projectSale(sale, nested.sale.select ?? {})
      : null;
    return projected;
  }

  private projectSale(
    sale: SaleRow,
    select: Record<string, unknown>,
  ): Record<string, unknown> {
    const scalars = sale as unknown as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(select)) {
      if (value === true) {
        projected[field] = scalars[field];
        continue;
      }
      if (field === 'customer') {
        const nestedSelect =
          (value as { select?: Record<string, unknown> }).select ?? {};
        const customer = this.customers.find(
          (row) => row.id === sale.customerId,
        );
        projected.customer = customer
          ? this.projectScalars(
              customer as unknown as Record<string, unknown>,
              nestedSelect,
            )
          : null;
        continue;
      }
      if (field === 'shippingAddress') {
        const nestedSelect =
          (value as { select?: Record<string, unknown> }).select ?? {};
        const address = this.addresses.find(
          (row) => row.id === sale.shippingAddressId,
        );
        projected.shippingAddress = address
          ? this.projectScalars(
              address as unknown as Record<string, unknown>,
              nestedSelect,
            )
          : null;
        continue;
      }
      throw new Error(
        `FakePrismaTransactionClient: unsupported sale select field ${field}`,
      );
    }
    return projected;
  }

  private projectScalars(
    row: Record<string, unknown>,
    select: Record<string, unknown>,
  ): Record<string, unknown> {
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(select)) {
      if (select[key] !== true) {
        throw new Error(
          `FakePrismaTransactionClient: unsupported nested scalar select ${key}`,
        );
      }
      projected[key] = row[key];
    }
    return projected;
  }

  /** Raw `where` of every `deliveryRoute.delete` (the ODD O1 delete path). */
  readonly routeDeletes: Predicate[] = [];

  readonly deliveryRoute = {
    updateMany: (args: { where: Predicate; data: Partial<RouteRow> }) => {
      this.routeUpdates.push(args.where);
      let count = 0;
      this.routes = this.routes.map((row) => {
        if (
          !matchesWhere(row as unknown as Record<string, unknown>, args.where)
        ) {
          return row;
        }
        count++;
        return { ...row, ...args.data };
      });
      return Promise.resolve({ count });
    },
    findFirst: (args: { where: Predicate; include?: RouteInclude }) => {
      this.routeReads.push(args.where);
      this.routeIncludes.push(args.include);
      const row = this.routes.find((candidate) =>
        matchesWhere(
          candidate as unknown as Record<string, unknown>,
          args.where,
        ),
      );
      if (!row) return Promise.resolve(null);
      const stopsInclude = args.include?.stops;
      if (!stopsInclude) return Promise.resolve({ ...row });
      // The nested filter is EXECUTED, never ignored: a `routeId` match
      // alone must not rehydrate a stop row that another tenant owns.
      return Promise.resolve({
        ...row,
        stops: this.nestedStops(row, stopsInclude),
      });
    },
    // The ODD O1 delete path: capture the call and remove the matching route
    // row. A miss rejects like Prisma's P2025 rather than silently succeeding,
    // so a spec cannot pass on a no-op delete.
    delete: (args: { where: Predicate }) => {
      this.routeDeletes.push(args.where);
      const index = this.routes.findIndex((candidate) =>
        matchesWhere(
          candidate as unknown as Record<string, unknown>,
          args.where,
        ),
      );
      if (index === -1) {
        return Promise.reject(
          new Error(
            `FakePrismaTransactionClient: no route row matched delete ${JSON.stringify(
              args.where,
            )}`,
          ),
        );
      }
      const [deleted] = this.routes.splice(index, 1);
      return Promise.resolve({ ...deleted });
    },
    findMany: (args: {
      where: Predicate;
      include?: RouteInclude;
      orderBy?: { createdAt?: 'asc' | 'desc' };
    }) => {
      this.routeListWhere.push(args.where);
      this.routeListIncludes.push(args.include);
      const direction = args.orderBy?.createdAt;
      if (
        direction !== undefined &&
        direction !== 'asc' &&
        direction !== 'desc'
      ) {
        throw new Error(
          `FakePrismaTransactionClient: unsupported route orderBy ${JSON.stringify(
            args.orderBy,
          )}`,
        );
      }
      const rows = this.routes
        .filter((row) =>
          matchesWhere(row as unknown as Record<string, unknown>, args.where),
        )
        .map((row) => {
          const stopsInclude = args.include?.stops;
          return stopsInclude
            ? { ...row, stops: this.nestedStops(row, stopsInclude) }
            : { ...row };
        });
      if (direction) {
        rows.sort((a, b) =>
          direction === 'asc'
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : b.createdAt.getTime() - a.createdAt.getTime(),
        );
      }
      return Promise.resolve(rows);
    },
  };

  readonly deliveryRouteStop = {
    updateMany: (args: { where: Predicate; data: Partial<StopRow> }) => {
      this.stopUpdates.push(args.where);
      let count = 0;
      this.stops = this.stops.map((row) => {
        if (
          !matchesWhere(row as unknown as Record<string, unknown>, args.where)
        ) {
          return row;
        }
        count++;
        return { ...row, ...args.data };
      });
      return Promise.resolve({ count });
    },
    count: (args: { where: Predicate }) => {
      this.stopCounts.push(args.where);
      const count = this.stops.filter((row) =>
        matchesWhere(row as unknown as Record<string, unknown>, args.where),
      ).length;
      return Promise.resolve(count);
    },
    // The pre-O1 seam replaced the whole stop set through these two calls.
    // Making them throw turns "no full replacement on the conditional seam"
    // into a hard, observable invariant of this suite.
    deleteMany: () => {
      throw new Error('commitTransition must not delete the stop set');
    },
    createMany: () => {
      throw new Error('commitTransition must not recreate the stop set');
    },
  };
}

const asTransactionClient = (client: FakePrismaTransactionClient) =>
  // SAFETY: the double exposes exactly the delegates `commitTransition`
  // touches (route updateMany/findFirst, stop updateMany/count); the
  // assertion only narrows it to the port's client type.
  client as unknown as Prisma.TransactionClient;

/** The adapter's non-conditional reads (`findById`) go through the
 *  tenant-scoped client; point it at the SAME stateful double so a spec can
 *  re-read exactly what the commit wrote. */
const makeRepo = (client: FakePrismaTransactionClient) =>
  new PrismaDeliveryRouteRepository({
    getClient: () => client,
  } as unknown as TenantPrismaService);

/** Build a real ACTIVE aggregate (production domain code, no fixtures). */
const makeActiveRoute = async (
  saleIds: string[],
  options: { id?: string; now?: Date } = {},
): Promise<DeliveryRoute> => {
  const now = options.now ?? NOW;
  const route = await DeliveryRoute.create({
    id: options.id,
    tenantId: TENANT_ID,
    driverUserId: DRIVER_ID,
    saleIds,
    checkSaleEligibility: () =>
      Promise.resolve({
        deliveryStatus: 'PENDING' as const,
        shippingAddressId: 'addr-1',
      }),
    now,
  });
  route.start({ now });
  return route;
};

/** Build a real DRAFT aggregate (production domain code, no fixtures).
 *  DRAFT is the only status the adapter delete precondition accepts. */
const makeDraftRoute = (
  saleIds: string[],
  options: { id?: string; now?: Date } = {},
): Promise<DeliveryRoute> =>
  DeliveryRoute.create({
    id: options.id,
    tenantId: TENANT_ID,
    driverUserId: DRIVER_ID,
    saleIds,
    checkSaleEligibility: () =>
      Promise.resolve({
        deliveryStatus: 'PENDING' as const,
        shippingAddressId: 'addr-1',
      }),
    now: options.now ?? NOW,
  });

/** Project an aggregate into the double's rows. */
const seed = (client: FakePrismaTransactionClient, route: DeliveryRoute) => {
  const projection = route.toPersistence();
  const { stops, ...routeRow } = projection;
  client.routes = [routeRow];
  // A persisted stop always carries its owning route id (the aggregate only
  // rewrites it on re-hydration), so the conditional predicates below match
  // real persisted rows.
  client.stops = stops.map((stop) => ({ ...stop, routeId: route.id }));
};

/** Append an additional aggregate into the double's rows (the `list` read). */
const seedAppend = (
  client: FakePrismaTransactionClient,
  route: DeliveryRoute,
) => {
  const projection = route.toPersistence();
  const { stops, ...routeRow } = projection;
  client.routes = [...client.routes, routeRow];
  client.stops = [
    ...client.stops,
    ...stops.map((stop) => ({ ...stop, routeId: route.id })),
  ];
};

/** The nested `stops` include handed to Prisma, asserted structurally: a
 *  double that ignored nested relation filters would still have to receive
 *  this predicate, so this exposes a mock-hidden regression. */
const nestedStopsIncludeOf = (include: unknown): Record<string, unknown> => {
  const stops = (include as { stops?: unknown } | null | undefined)?.stops;
  if (typeof stops !== 'object' || stops === null) {
    throw new Error(
      `expected an explicit nested stops include, received ${JSON.stringify(
        include,
      )}`,
    );
  }
  return stops as Record<string, unknown>;
};

/** A foreign-tenant child row attached to the SAME routeId. The parent
 *  predicate cannot protect the nested relation. */
const foreignTenantStop = (template: StopRow, id: string): StopRow => ({
  ...template,
  id,
  tenantId: OTHER_TENANT_ID,
  saleId: 'sale-foreign',
  sortOrder: 99,
});

const stopStatuses = (client: FakePrismaTransactionClient, routeId: string) =>
  [...client.stops]
    .filter((stop) => stop.routeId === routeId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((stop) => stop.status);

describe('PrismaDeliveryRouteRepository nested stop tenant scoping (delivery-routes / ODD O1)', () => {
  it('Given a foreign-tenant stop sharing the route id, when findOneWithStops reads the route, then the foreign stop is excluded while tenant-owned stops keep their order and projection', async () => {
    const route = await makeActiveRoute(['sale-1', 'sale-2']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    client.stops = [
      ...client.stops,
      foreignTenantStop(client.stops[0], 'stop-foreign-tenant-detail'),
    ];
    const repo = makeRepo(client);

    const read = await repo.findOneWithStops({
      tenantId: TENANT_ID,
      id: route.id,
    });

    expect(read).not.toBeNull();
    // The foreign-tenant row IS in the data set...
    expect(client.stops).toHaveLength(3);
    // ...and still never reaches the read model, while the tenant's own
    // stops keep sortOrder and sale projection.
    expect(read!.stops.map((stop) => stop.id)).toEqual(
      route.stops.map((stop) => stop.id),
    );
    expect(read!.stops.map((stop) => stop.sortOrder)).toEqual([0, 1]);
    expect(read!.stops.map((stop) => stop.saleId)).toEqual([
      'sale-1',
      'sale-2',
    ]);
    // The parent predicate is preserved unchanged.
    expect(client.routeReads[0]).toEqual({
      id: route.id,
      tenantId: TENANT_ID,
    });
    // Structural proof for the single read.
    expect(
      nestedStopsIncludeOf(
        client.routeIncludes[client.routeIncludes.length - 1],
      ),
    ).toMatchObject({
      where: { tenantId: TENANT_ID },
      orderBy: { sortOrder: 'asc' },
    });
  });

  it('Given a foreign-tenant stop sharing a route id, when list reads the tenant routes, then parent filters and createdAt order survive and only tenant-owned stops are projected', async () => {
    const older = await makeActiveRoute(['sale-1', 'sale-2'], {
      id: 'route-older',
      now: NOW,
    });
    const newer = await makeActiveRoute(['sale-3'], {
      id: 'route-newer',
      now: LATER,
    });
    const client = new FakePrismaTransactionClient();
    seed(client, older);
    seedAppend(client, newer);
    client.stops = [
      ...client.stops,
      foreignTenantStop(client.stops[0], 'stop-foreign-tenant-list'),
    ];
    const repo = makeRepo(client);

    const rows = await repo.list({
      tenantId: TENANT_ID,
      driverUserId: DRIVER_ID,
      status: ['ACTIVE'],
    });

    // Parent tenant / driver / status predicates and route ordering survive.
    expect(client.routeListWhere).toEqual([
      {
        tenantId: TENANT_ID,
        driverUserId: DRIVER_ID,
        status: { in: ['ACTIVE'] },
      },
    ]);
    expect(rows.map((row) => row.id)).toEqual(['route-newer', 'route-older']);
    // Tenant-owned stops are projected in sortOrder; the foreign-tenant row
    // (present in the data set) appears in no route's stop list.
    expect(client.stops).toHaveLength(4);
    expect(rows[0].stops.map((stop) => stop.id)).toEqual([newer.stops[0].id]);
    expect(rows[1].stops.map((stop) => stop.id)).toEqual(
      older.stops.map((stop) => stop.id),
    );
    expect(rows.flatMap((row) => row.stops).map((stop) => stop.saleId)).toEqual(
      ['sale-3', 'sale-1', 'sale-2'],
    );
    // Structural proof for the list read.
    expect(nestedStopsIncludeOf(client.routeListIncludes[0])).toMatchObject({
      where: { tenantId: TENANT_ID },
      orderBy: { sortOrder: 'asc' },
    });
  });
});

// ── Delete precondition stop tenant scoping (ODD O1) ─────────────────

/** Move every child row of the seeded route into another tenant, so the
 *  route keeps NO tenant-owned stop while a foreign stop still shares its
 *  route id (the unfiltered probe's failure mode). */
const handRouteStopsToAnotherTenant = (
  client: FakePrismaTransactionClient,
): void => {
  client.stops = client.stops.map((stop) => ({
    ...stop,
    tenantId: OTHER_TENANT_ID,
  }));
};

describe('PrismaDeliveryRouteRepository.delete stop precondition tenant scoping (delivery-routes / ODD O1)', () => {
  it('Given a DRAFT tenant route whose only stop row belongs to another tenant, when delete runs, then the zero-stop precondition passes and the route row is removed exactly once', async () => {
    const route = await makeDraftRoute(['sale-1']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    handRouteStopsToAnotherTenant(client);
    // The child row IS attached to this route id...
    expect(client.stops).toHaveLength(1);
    expect(client.stops[0].routeId).toBe(route.id);
    const repo = makeRepo(client);

    await repo.delete({ tenantId: TENANT_ID, id: route.id });

    // ...and no longer blocks the delete: the probe found zero tenant-owned
    // stops, so exactly one delete call was issued for the route row.
    expect(client.routeDeletes).toEqual([{ id: route.id }]);
    expect(client.routes).toHaveLength(0);
    // The parent predicate is preserved unchanged.
    expect(client.routeReads[0]).toEqual({
      id: route.id,
      tenantId: TENANT_ID,
    });
  });

  it('Given a DRAFT tenant route with a same-tenant stop, when delete runs, then it stays blocked with DELIVERY_ROUTE_INVALID_TRANSITION, issues no delete call and keeps the route row', async () => {
    const route = await makeDraftRoute(['sale-1']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    const repo = makeRepo(client);

    const deletion = repo.delete({ tenantId: TENANT_ID, id: route.id });
    await expect(deletion).rejects.toBeInstanceOf(BusinessRuleViolationError);
    await expect(deletion).rejects.toMatchObject({
      code: 'DELIVERY_ROUTE_INVALID_TRANSITION',
    });

    // Blocked before the delete call, and the row survives.
    expect(client.routeDeletes).toHaveLength(0);
    expect(client.routes).toHaveLength(1);
    expect(client.stops).toHaveLength(1);
    expect(client.routeReads[0]).toEqual({
      id: route.id,
      tenantId: TENANT_ID,
    });
  });

  it('Given the delete precondition read, when the nested stop include is submitted, then it is exactly tenant-filtered and still capped at one row', async () => {
    const route = await makeDraftRoute(['sale-1']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    handRouteStopsToAnotherTenant(client);
    const repo = makeRepo(client);

    await repo.delete({ tenantId: TENANT_ID, id: route.id });

    // Exact equality, not a partial match: a dropped tenant predicate, a
    // dropped `take`, or an added permissive option all fail here. The double
    // EXECUTES `where` and `take`, so this structural assertion guards real
    // behavior instead of a recording that ignores the predicate.
    expect(
      nestedStopsIncludeOf(
        client.routeIncludes[client.routeIncludes.length - 1],
      ),
    ).toEqual({ where: { tenantId: TENANT_ID }, take: 1 });
  });
});

// ── Nested sale / customer / address tenant defense (ODD O1) ──────────

/** The nested `sale.select` handed to Prisma for a route read. Asserted
 *  structurally so a double that ignored the select could not conceal a
 *  missing `tenantId` on the sale, its customer, or its address. */
const nestedSaleSelectOf = (include: unknown): Record<string, unknown> => {
  const nested = nestedStopsIncludeOf(include).include as
    | { sale?: { select?: unknown } }
    | undefined;
  const select = nested?.sale?.select;
  if (typeof select !== 'object' || select === null) {
    throw new Error(
      `expected an explicit nested sale select, received ${JSON.stringify(
        nested,
      )}`,
    );
  }
  return select as Record<string, unknown>;
};

/** The exact nested projection both route reads must request. */
const NESTED_SALE_SELECT = {
  id: true,
  tenantId: true,
  folio: true,
  customer: {
    select: {
      id: true,
      tenantId: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  shippingAddress: {
    select: {
      id: true,
      tenantId: true,
      street: true,
      exteriorNumber: true,
      interiorNumber: true,
      zipCode: true,
      neighborhood: true,
      municipality: true,
      city: true,
      state: true,
      label: true,
    },
  },
};

/** The projected address `seedSaleGraph` produces for `address-1`. */
const EXPECTED_ADDRESS = {
  id: 'address-1',
  street: 'Main St',
  exteriorNumber: '100',
  interiorNumber: '2B',
  zipCode: '06000',
  neighborhood: 'Centro',
  municipality: 'Cuauhtemoc',
  city: 'CDMX',
  state: 'CDMX',
  label: 'Home',
};

/** Seed the nested to-one rows the double resolves for `stops.include.sale`.
 *  `tenantId` is overridable per row so a spec can build a foreign child. */
const seedSaleGraph = (
  client: FakePrismaTransactionClient,
  graph: {
    saleId: string;
    saleTenantId?: string;
    folio?: string;
    customer?: {
      id: string;
      tenantId?: string;
      firstName?: string;
      lastName?: string | null;
      email?: string | null;
    } | null;
    address?: {
      id: string;
      tenantId?: string;
      street?: string;
      label?: string | null;
    } | null;
  },
): void => {
  client.sales = [
    ...client.sales.filter((sale) => sale.id !== graph.saleId),
    {
      id: graph.saleId,
      tenantId: graph.saleTenantId ?? TENANT_ID,
      folio: graph.folio ?? `FOLIO-${graph.saleId}`,
      customerId: graph.customer?.id ?? null,
      shippingAddressId: graph.address?.id ?? null,
    },
  ];
  const customer = graph.customer;
  if (customer) {
    client.customers = [
      ...client.customers.filter((row) => row.id !== customer.id),
      {
        id: customer.id,
        tenantId: customer.tenantId ?? TENANT_ID,
        firstName: customer.firstName ?? 'Ada',
        lastName: customer.lastName ?? null,
        email: customer.email ?? null,
      },
    ];
  }
  const address = graph.address;
  if (address) {
    client.addresses = [
      ...client.addresses.filter((row) => row.id !== address.id),
      {
        id: address.id,
        tenantId: address.tenantId ?? TENANT_ID,
        street: address.street ?? 'Main St',
        exteriorNumber: '100',
        interiorNumber: '2B',
        zipCode: '06000',
        neighborhood: 'Centro',
        municipality: 'Cuauhtemoc',
        city: 'CDMX',
        state: 'CDMX',
        label: address.label ?? 'Home',
      },
    ];
  }
};

const READ_METHODS = ['findOneWithStops', 'list'] as const;
type ReadMethod = (typeof READ_METHODS)[number];

/** Drive either route read through the same assertion path, so the matrix
 *  below is exercised identically by the detail and the list read. */
const readSoleRoute = async (
  method: ReadMethod,
  repo: PrismaDeliveryRouteRepository,
  routeId: string,
): Promise<DeliveryRouteReadModel> => {
  if (method === 'findOneWithStops') {
    const read = await repo.findOneWithStops({
      tenantId: TENANT_ID,
      id: routeId,
    });
    if (read === null) throw new Error('expected the route detail read model');
    return read;
  }
  const rows = await repo.list({ tenantId: TENANT_ID });
  const row = rows.find((candidate) => candidate.id === routeId);
  if (!row) throw new Error('expected the route in the list read model');
  return row;
};

describe.each(READ_METHODS)(
  'PrismaDeliveryRouteRepository nested sale tenant scoping via %s (delivery-routes / ODD O1)',
  (method) => {
    it('Given a tenant-owned stop whose nested sale belongs to another tenant, when the route is read, then the stop keeps its saleId while folio, customer and address are withheld', async () => {
      const route = await makeActiveRoute(['sale-1']);
      const client = new FakePrismaTransactionClient();
      seed(client, route);
      seedSaleGraph(client, {
        saleId: 'sale-1',
        saleTenantId: OTHER_TENANT_ID,
        folio: 'FOREIGN-FOLIO',
        customer: {
          id: 'customer-foreign',
          tenantId: OTHER_TENANT_ID,
          firstName: 'For',
          lastName: 'Eigner',
        },
        address: {
          id: 'address-foreign',
          tenantId: OTHER_TENANT_ID,
          street: 'Foreign Ave',
        },
      });
      const repo = makeRepo(client);

      const read = await readSoleRoute(method, repo, route.id);
      const stop = read.stops[0];

      // The foreign graph IS in the data set...
      expect(client.sales).toHaveLength(1);
      expect(client.sales[0].tenantId).toBe(OTHER_TENANT_ID);
      expect(client.customers).toHaveLength(1);
      expect(client.addresses).toHaveLength(1);
      // ...and is still withheld: only the tenant's own stop column survives.
      expect(stop.saleId).toBe('sale-1');
      expect(stop.saleFolio).toBeNull();
      expect(stop.customer).toBeNull();
      expect(stop.shippingAddress).toBeNull();
    });

    it('Given a same-tenant sale with a foreign customer and a valid address, when the route is read, then the customer is withheld while the address is preserved', async () => {
      const route = await makeActiveRoute(['sale-1']);
      const client = new FakePrismaTransactionClient();
      seed(client, route);
      seedSaleGraph(client, {
        saleId: 'sale-1',
        folio: 'FOLIO-OWN',
        customer: {
          id: 'customer-foreign',
          tenantId: OTHER_TENANT_ID,
          firstName: 'For',
          lastName: 'Eigner',
        },
        address: { id: 'address-1' },
      });
      const repo = makeRepo(client);

      const read = await readSoleRoute(method, repo, route.id);
      const stop = read.stops[0];

      // A foreign customer must not suppress the valid same-tenant address.
      expect(stop.saleFolio).toBe('FOLIO-OWN');
      expect(stop.customer).toBeNull();
      expect(stop.shippingAddress).toEqual(EXPECTED_ADDRESS);
    });

    it('Given a same-tenant sale with a valid customer and a foreign address, when the route is read, then the customer is preserved while the address is withheld', async () => {
      const route = await makeActiveRoute(['sale-1']);
      const client = new FakePrismaTransactionClient();
      seed(client, route);
      seedSaleGraph(client, {
        saleId: 'sale-1',
        folio: 'FOLIO-OWN',
        customer: {
          id: 'customer-1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
        },
        address: {
          id: 'address-foreign',
          tenantId: OTHER_TENANT_ID,
          street: 'Foreign Ave',
        },
      });
      const repo = makeRepo(client);

      const read = await readSoleRoute(method, repo, route.id);
      const stop = read.stops[0];

      // A foreign address must not suppress the valid same-tenant customer.
      expect(stop.saleFolio).toBe('FOLIO-OWN');
      expect(stop.customer).toEqual({
        id: 'customer-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      });
      expect(stop.shippingAddress).toBeNull();
    });

    it('Given a fully same-tenant nested graph, when the route is read, then the sale, customer and address projections are unchanged', async () => {
      const route = await makeActiveRoute(['sale-1']);
      const client = new FakePrismaTransactionClient();
      seed(client, route);
      seedSaleGraph(client, {
        saleId: 'sale-1',
        folio: 'FOLIO-OWN',
        customer: {
          id: 'customer-1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
        },
        address: { id: 'address-1' },
      });
      const repo = makeRepo(client);

      const read = await readSoleRoute(method, repo, route.id);
      const stop = read.stops[0];

      expect(stop.saleId).toBe('sale-1');
      expect(stop.saleFolio).toBe('FOLIO-OWN');
      expect(stop.customer).toEqual({
        id: 'customer-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      });
      expect(stop.shippingAddress).toEqual(EXPECTED_ADDRESS);
    });
  },
);

describe('PrismaDeliveryRouteRepository nested sale select projection (delivery-routes / ODD O1)', () => {
  it('Given both route read methods, when the nested include is submitted, then the sale, customer and shippingAddress select all request tenantId', async () => {
    const route = await makeActiveRoute(['sale-1']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    const repo = makeRepo(client);

    await repo.findOneWithStops({ tenantId: TENANT_ID, id: route.id });
    await repo.list({ tenantId: TENANT_ID });

    // The detail read: the full nested projection is requested verbatim.
    expect(
      nestedSaleSelectOf(
        client.routeIncludes[client.routeIncludes.length - 1],
      ),
    ).toEqual(NESTED_SALE_SELECT);
    // The list read: the same projection, so neither read can drift.
    expect(
      nestedSaleSelectOf(
        client.routeListIncludes[client.routeListIncludes.length - 1],
      ),
    ).toEqual(NESTED_SALE_SELECT);
    // Focused tenantId assertion, independent of the full-select equality.
    for (const include of [
      client.routeIncludes[client.routeIncludes.length - 1],
      client.routeListIncludes[client.routeListIncludes.length - 1],
    ]) {
      expect(nestedSaleSelectOf(include)).toMatchObject({
        tenantId: true,
        customer: { select: { tenantId: true } },
        shippingAddress: { select: { tenantId: true } },
      });
    }
  });
});

/** A competing writer commits directly into the double's rows. */
const competingWriterCompletesStop = (
  client: FakePrismaTransactionClient,
  routeId: string,
  stopId: string,
  at: Date,
) => {
  client.routes = client.routes.map((row) =>
    row.id === routeId ? { ...row, updatedAt: at } : row,
  );
  client.stops = client.stops.map((stop) =>
    stop.id === stopId
      ? { ...stop, status: 'COMPLETED', checkedInAt: at, completedAt: at }
      : stop,
  );
};

describe('PrismaDeliveryRouteRepository.commitTransition (delivery-routes / ODD O1)', () => {
  it('Given a fresh snapshot, when a stop check-in is committed, then it compare-and-sets the parent row tenant-qualified and writes ONLY the changed stop', async () => {
    const route = await makeActiveRoute(['sale-1', 'sale-2', 'sale-3']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    const repo = makeRepo(client);

    const expected = captureRouteTransitionExpectation(route);
    route.checkInStop({ stopId: route.stops[1].id, now: LATER });

    const outcome = await repo.commitTransition({
      tx: asTransactionClient(client),
      tenantId: TENANT_ID,
      routeId: route.id,
      expected,
      next: route,
    });

    expect(outcome).toEqual({ kind: 'committed' });

    // Parent compare-and-set: every predicate is tenant-qualified.
    expect(client.routeUpdates).toHaveLength(1);
    expect(client.routeUpdates[0]).toEqual({
      id: route.id,
      tenantId: TENANT_ID,
      status: 'ACTIVE',
      startedAt: NOW,
      completedAt: null,
      cancelledAt: null,
      updatedAt: NOW,
    });

    // Exactly ONE stop was written, and its predicate carried tenantId,
    // routeId and the expected prior stop state.
    expect(client.stopUpdates).toHaveLength(1);
    expect(client.stopUpdates[0]).toEqual({
      id: route.stops[1].id,
      tenantId: TENANT_ID,
      routeId: route.id,
      status: 'PENDING',
      checkedInAt: null,
      completedAt: null,
      activeRouteId: route.id,
    });

    // The other stops (and their ADR-7 markers) are untouched.
    expect(stopStatuses(client, route.id)).toEqual([
      'PENDING',
      'COMPLETED',
      'PENDING',
    ]);
    expect(
      client.stops.filter((stop) => stop.status === 'PENDING'),
    ).toHaveLength(2);
    // Route stayed ACTIVE (pending stops remain) and the completion
    // reconciliation issued a tenant-qualified open-stop count.
    expect(client.routes[0].status).toBe('ACTIVE');
    expect(client.stopCounts).toEqual([
      {
        routeId: route.id,
        tenantId: TENANT_ID,
        status: { in: ['PENDING', 'IN_PROGRESS'] },
      },
    ]);
  });

  it('Given a competing check-in of the same stop, when an already-COMPLETED replay commits, then no stop row is written (so no duplicate next-stop side effect can follow)', async () => {
    const route = await makeActiveRoute(['sale-1', 'sale-2']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    const repo = makeRepo(client);

    // The competitor commits the stop transition first.
    competingWriterCompletesStop(client, route.id, route.stops[0].id, LATER);
    // The loser re-read its state AFTER that commit: the stop is COMPLETED.
    const replayRoute = await repo.findById({
      tenantId: TENANT_ID,
      id: route.id,
    });
    expect(replayRoute).not.toBeNull();
    const expected = captureRouteTransitionExpectation(replayRoute!);
    replayRoute!.checkInStop({ stopId: route.stops[0].id });

    const outcome = await repo.commitTransition({
      tx: asTransactionClient(client),
      tenantId: TENANT_ID,
      routeId: route.id,
      expected,
      next: replayRoute!,
    });

    expect(outcome).toEqual({ kind: 'committed' });
    // No stop write: the replay is a pure no-op on the stop set.
    expect(client.stopUpdates).toHaveLength(0);
    expect(stopStatuses(client, route.id)).toEqual(['COMPLETED', 'PENDING']);
  });

  it('Given a stale snapshot whose parent row changed, when the commit is attempted, then it reports stale without writing any stop', async () => {
    const route = await makeActiveRoute(['sale-1', 'sale-2', 'sale-3']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    const repo = makeRepo(client);

    // Caller's snapshot (status ACTIVE / updatedAt NOW).
    const expected = captureRouteTransitionExpectation(route);
    // A competing writer commits a different stop and bumps the parent row.
    competingWriterCompletesStop(client, route.id, route.stops[0].id, LATER);
    const before = JSON.stringify(client.stops);

    route.checkInStop({ stopId: route.stops[1].id, now: LATER });
    const outcome = await repo.commitTransition({
      tx: asTransactionClient(client),
      tenantId: TENANT_ID,
      routeId: route.id,
      expected,
      next: route,
    });

    expect(outcome).toEqual({ kind: 'stale' });
    // The winner's completion is preserved: nothing was overwritten.
    expect(client.stopUpdates).toHaveLength(0);
    expect(JSON.stringify(client.stops)).toBe(before);
    expect(stopStatuses(client, route.id)).toEqual([
      'COMPLETED',
      'PENDING',
      'PENDING',
    ]);
    // The stale classification is an explicit tenant-qualified re-read.
    expect(client.routeReads).toContainEqual({
      id: route.id,
      tenantId: TENANT_ID,
    });
  });
  it('Given a stale cancel that would resurrect a completed stop, when the commit is attempted, then the completed stop survives and the outcome is stale', async () => {
    const route = await makeActiveRoute(['sale-1', 'sale-2']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    const repo = makeRepo(client);

    // The cancellation request loaded the route while stop[0] was PENDING.
    const expected = captureRouteTransitionExpectation(route);
    // A competing check-in wins first.
    competingWriterCompletesStop(client, route.id, route.stops[0].id, LATER);
    // The stale cancellation snapshot still believes stop[0] is PENDING.
    route.cancel({ now: LATER });

    const outcome = await repo.commitTransition({
      tx: asTransactionClient(client),
      tenantId: TENANT_ID,
      routeId: route.id,
      expected,
      next: route,
    });

    expect(outcome).toEqual({ kind: 'stale' });
    expect(stopStatuses(client, route.id)).toEqual(['COMPLETED', 'PENDING']);
    expect(client.routes[0].status).toBe('ACTIVE');
    expect(client.stopUpdates).toHaveLength(0);
  });

  it('Given a route that only exists in another tenant, when the commit is attempted, then it reports missing without cross-tenant disclosure', async () => {
    const route = await makeActiveRoute(['sale-1']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    client.stops = client.stops.map((stop) => ({
      ...stop,
      tenantId: OTHER_TENANT_ID,
    }));
    const repo = makeRepo(client);

    const expected = captureRouteTransitionExpectation(route);
    route.cancel({ now: LATER });

    const outcome = await repo.commitTransition({
      tx: asTransactionClient(client),
      tenantId: OTHER_TENANT_ID,
      routeId: route.id,
      expected,
      next: route,
    });

    expect(outcome).toEqual({ kind: 'missing' });
    expect(client.routeUpdates[0].tenantId).toBe(OTHER_TENANT_ID);
    expect(client.routeReads).toEqual([
      { id: route.id, tenantId: OTHER_TENANT_ID },
    ]);
    expect(client.stopUpdates).toHaveLength(0);
    expect(client.routes[0].status).toBe('ACTIVE');
  });

  it('Given a foreign-tenant stop row sharing this route id, when the aggregate is loaded, then only tenant-visible stops are rehydrated', async () => {
    const route = await makeActiveRoute(['sale-1', 'sale-2']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    // A child row attached to the SAME routeId but owned by another
    // tenant. The parent predicate cannot protect the nested relation:
    // only an explicit `include.stops.where.tenantId` keeps it out of the
    // rehydrated aggregate.
    client.stops = [
      ...client.stops,
      {
        ...client.stops[0],
        id: 'stop-foreign-tenant',
        tenantId: OTHER_TENANT_ID,
        saleId: 'sale-foreign',
        sortOrder: 99,
      },
    ];
    const repo = makeRepo(client);

    const loaded = await repo.findById({ tenantId: TENANT_ID, id: route.id });

    expect(loaded).not.toBeNull();
    // The foreign-tenant child is NOT rehydrated, and the tenant's own stop
    // set is untouched.
    expect(loaded!.stops.map((stop) => stop.id)).toEqual(
      route.stops.map((stop) => stop.id),
    );
    expect(loaded!.stops.some((stop) => stop.tenantId !== TENANT_ID)).toBe(
      false,
    );
    expect(loaded!.stops).toHaveLength(route.stops.length);
    // Structural proof: the nested read carries the explicit tenant filter.
    expect(client.routeIncludes).toContainEqual({
      stops: { where: { tenantId: TENANT_ID } },
    });
  });

  it('Given the final pending stop, when it commits, then the route auto-completes from the PERSISTED stop set and the ADR-7 markers are cleared', async () => {
    const route = await makeActiveRoute(['sale-1', 'sale-2']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    const repo = makeRepo(client);

    // stop[0] was completed by a concurrent winner that this snapshot
    // never saw... so the persisted set is consulted, not the snapshot.
    competingWriterCompletesStop(client, route.id, route.stops[0].id, LATER);
    const fresh = await repo.findById({ tenantId: TENANT_ID, id: route.id });
    expect(fresh).not.toBeNull();
    const expected = captureRouteTransitionExpectation(fresh!);
    fresh!.checkInStop({ stopId: route.stops[1].id, now: LATER });

    const outcome = await repo.commitTransition({
      tx: asTransactionClient(client),
      tenantId: TENANT_ID,
      routeId: route.id,
      expected,
      next: fresh!,
    });

    expect(outcome).toEqual({ kind: 'committed' });
    expect(stopStatuses(client, route.id)).toEqual(['COMPLETED', 'COMPLETED']);
    // The persisted-state reconciliation completed the route...
    expect(client.routes[0].status).toBe('COMPLETED');
    expect(client.routes[0].completedAt).not.toBeNull();
    // ...and cleared every ADR-7 marker (tenant-qualified predicate).
    expect(client.stops.every((stop) => stop.activeRouteId === null)).toBe(
      true,
    );
  });

  it('Given a route that still has a pending stop, when one stop commits, then the route stays ACTIVE and the open-stop count is tenant-qualified', async () => {
    const route = await makeActiveRoute(['sale-1', 'sale-2']);
    const client = new FakePrismaTransactionClient();
    seed(client, route);
    const repo = makeRepo(client);

    const expected = captureRouteTransitionExpectation(route);
    route.checkInStop({ stopId: route.stops[0].id, now: LATER });

    const outcome = await repo.commitTransition({
      tx: asTransactionClient(client),
      tenantId: TENANT_ID,
      routeId: route.id,
      expected,
      next: route,
    });

    expect(outcome).toEqual({ kind: 'committed' });
    expect(client.routes[0].status).toBe('ACTIVE');
    expect(client.stopCounts).toHaveLength(1);
    expect(client.stopCounts[0]).toEqual({
      routeId: route.id,
      tenantId: TENANT_ID,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    });
    // The remaining stop keeps its marker: the route is still ACTIVE.
    expect(
      client.stops.find((stop) => stop.status === 'PENDING')?.activeRouteId,
    ).toBe(route.id);
  });

  it('Given a checkpoint cancellation of a DRAFT route, when it commits, then the stop set is untouched and no route-level completion is attempted', async () => {
    const route = await makeActiveRoute(['sale-1', 'sale-2']);
    const client = new FakePrismaTransactionClient();
    // Model the DRAFT case by seeding a route with no ADR-7 markers.
    seed(client, route);
    client.stops = client.stops.map((stop) => ({
      ...stop,
      activeRouteId: null,
    }));
    client.routes = client.routes.map((row) => ({
      ...row,
      status: 'DRAFT' as const,
      startedAt: null,
    }));
    const repo = makeRepo(client);
    const draft = await repo.findById({ tenantId: TENANT_ID, id: route.id });
    expect(draft).not.toBeNull();
    const expected = captureRouteTransitionExpectation(draft!);
    draft!.cancel({ now: LATER });

    const outcome = await repo.commitTransition({
      tx: asTransactionClient(client),
      tenantId: TENANT_ID,
      routeId: route.id,
      expected,
      next: draft!,
    });

    expect(outcome).toEqual({ kind: 'committed' });
    expect(client.routes[0].status).toBe('CANCELLED');
    // Nothing in the stop set changed, so no stop write was issued.
    expect(client.stopUpdates).toHaveLength(0);
    expect(client.stopCounts).toEqual([
      {
        routeId: route.id,
        tenantId: TENANT_ID,
        status: { in: ['PENDING', 'IN_PROGRESS'] },
      },
    ]);
  });
});
