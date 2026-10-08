/**
 * INFRASTRUCTURE SPEC: PrismaEligibleSalesReader — delivery-routes / T4.
 *
 * Uses a mocked Prisma client (no DB). Proves the tenant defenses on the
 * `q` search: every `customer` / `shippingAddress` relation branch carries
 * the caller's `tenantId`, and the SAME tenant-scoped `where` drives both
 * `findMany` (rows) and `count`, so a foreign-tenant related row cannot be
 * matched by either the page or the total.
 */
import type { Prisma } from '@prisma/client';
import { PrismaEligibleSalesReader } from './eligible-sales-prisma.reader';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

const makeHarness = () => {
  const findMany = jest.fn();
  const count = jest.fn();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
  const findFirst = jest.fn();
  const client = {
    sale: { findMany, count },
    deliveryRoute: { findFirst },
  };
  const tenantPrisma = { getClient: () => client };
  const reader = new PrismaEligibleSalesReader(
    tenantPrisma as unknown as TenantPrismaService,
  );
  return { reader, findMany, count, findFirst };
};

const whereOf = (mock: jest.Mock): Prisma.SaleWhereInput => {
  const calls = mock.mock.calls as Array<[{ where: Prisma.SaleWhereInput }]>;
  return calls[0][0].where;
};

const searchBranches = (
  where: Prisma.SaleWhereInput,
): Prisma.SaleWhereInput[] => {
  const ands = where.AND as Prisma.SaleWhereInput[];
  const search = ands.find((clause) => 'OR' in clause) as
    | { OR: Prisma.SaleWhereInput[] }
    | undefined;
  return search?.OR ?? [];
};

describe('PrismaEligibleSalesReader — tenant defenses', () => {
  it('omits foreign context stops while preserving local stop identity and order', async () => {
    const { reader, findFirst } = makeHarness();
    findFirst.mockResolvedValue({
      id: 'route-1',
      status: 'DRAFT',
      driverUserId: 'driver-1',
      stops: [
        { id: 'foreign-stop', tenantId: 't2', saleId: 'sale-1', sortOrder: 0 },
        { id: 'local-stop', tenantId: 't1', saleId: 'sale-2', sortOrder: 1 },
      ],
    });

    const result = await reader.findContextRoute({
      tenantId: 't1',
      routeId: 'route-1',
    });

    expect(result).toEqual({
      id: 'route-1',
      status: 'DRAFT',
      driverUserId: 'driver-1',
      stops: [{ stopId: 'local-stop', saleId: 'sale-2', sortOrder: 1 }],
    });
    expect(findFirst.mock.calls).toHaveLength(1);
    expect((findFirst.mock.calls as unknown[][])[0][0]).toMatchObject({
      where: { id: 'route-1', tenantId: 't1' },
      select: {
        stops: {
          where: { tenantId: 't1' },
          select: { tenantId: true },
        },
      },
    });
  });

  it('ignores foreign stop occupancy without changing local reservations or page totals', async () => {
    const { reader, findMany, count } = makeHarness();
    const route = {
      id: 'route-1',
      status: 'DRAFT',
      tenantId: 't1',
      driverUserId: 'driver-1',
    };
    const base = {
      folio: '000001',
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
      deliveryStatus: 'PENDING',
      totalCents: 100,
      debtCents: 0,
      confirmedAt: null,
      dueDate: null,
      customer: null,
      shippingAddress: null,
      items: [],
    };
    findMany.mockResolvedValue([
      {
        ...base,
        id: 'sale-1',
        deliveryRouteStops: [{ tenantId: 't2', routeId: route.id, route }],
      },
      {
        ...base,
        id: 'sale-2',
        deliveryRouteStops: [{ tenantId: 't1', routeId: route.id, route }],
      },
    ]);
    count.mockResolvedValue(2);

    const result = await reader.findEligibleSales({
      tenantId: 't1',
      page: 1,
      limit: 20,
      saleScope: null,
    });

    const projected = {
      folio: base.folio,
      status: base.status,
      paymentStatus: base.paymentStatus,
      deliveryStatus: base.deliveryStatus,
      totalCents: 100,
      debtCents: 0,
      confirmedAt: null,
      dueDate: null,
      customer: null,
      shippingAddress: null,
      productNames: [],
    };
    expect(result).toEqual({
      total: 2,
      rows: [
        { ...projected, id: 'sale-1', occupancy: null },
        {
          ...projected,
          id: 'sale-2',
          occupancy: {
            routeId: 'route-1',
            routeStatus: 'DRAFT',
            routeDriverUserId: 'driver-1',
          },
        },
      ],
    });
    expect(findMany.mock.calls).toHaveLength(1);
    expect((findMany.mock.calls as unknown[][])[0][0]).toMatchObject({
      select: {
        deliveryRouteStops: {
          where: { tenantId: 't1', activeRouteId: { not: null } },
          select: { tenantId: true },
        },
      },
    });
  });
  it('drives rows and count with the SAME tenant-scoped where', async () => {
    const { reader, findMany, count } = makeHarness();

    await reader.findEligibleSales({
      tenantId: 't1',
      page: 1,
      limit: 20,
      q: 'Ana',
      saleScope: null,
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(1);
    const rowsWhere = whereOf(findMany);
    const countWhere = whereOf(count);
    expect(countWhere).toEqual(rowsWhere);
    expect(JSON.stringify(rowsWhere)).toContain('"tenantId":"t1"');
  });

  it('scopes every customer search branch by tenantId', async () => {
    const { reader, findMany } = makeHarness();

    await reader.findEligibleSales({
      tenantId: 't1',
      page: 1,
      limit: 20,
      q: 'Ana',
      saleScope: null,
    });

    const branches = searchBranches(whereOf(findMany)).filter(
      (clause) => 'customer' in clause,
    );
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      expect(branch.customer).toMatchObject({ tenantId: 't1' });
    }
  });

  it('scopes every shippingAddress search branch by tenantId', async () => {
    const { reader, findMany } = makeHarness();

    await reader.findEligibleSales({
      tenantId: 't1',
      page: 1,
      limit: 20,
      q: 'Centro',
      saleScope: null,
    });

    const branches = searchBranches(whereOf(findMany)).filter(
      (clause) => 'shippingAddress' in clause,
    );
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      expect(branch.shippingAddress).toMatchObject({ tenantId: 't1' });
    }
  });

  it('does not push a search clause when q is blank', async () => {
    const { reader, findMany, count } = makeHarness();

    await reader.findEligibleSales({
      tenantId: 't1',
      page: 1,
      limit: 20,
      q: '   ',
      saleScope: null,
    });

    expect(searchBranches(whereOf(findMany))).toHaveLength(0);
    expect(count).toHaveBeenCalledTimes(1);
  });
});
