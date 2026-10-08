/**
 * INFRASTRUCTURE: PrismaEligibleSalesReader — delivery-routes / T4.
 *
 * Tenant-qualified read adapter for the eligible-sales selector:
 *   - confirmed sales with `deliveryStatus IN (PENDING, SHIPPED)`
 *   - `q` search over customer first/last name, folio numeric suffix and
 *     the shipping address (street / neighborhood / municipality / city /
 *     zipCode)
 *   - stable `confirmedAt desc, id desc` ordering
 *   - occupancy from the `DeliveryRouteStop.activeRouteId` reservation
 *     marker, with tenant-qualified stops and post-read stop/route defenses
 *
 * Nested relations (`customer`, `shippingAddress`, `route`) cannot carry a
 * tenant predicate of their own, so every related row is re-checked against
 * the caller's `tenantId` after the read and dropped on mismatch — no
 * cross-tenant related PII ever reaches the service.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  EligibleSaleAddressProjection,
  EligibleSaleCustomerProjection,
  EligibleSaleOccupancyProjection,
  EligibleSaleRowProjection,
  EligibleSalesContextRouteProjection,
  EligibleSalesPageProjection,
  EligibleSalesReadInput,
  IEligibleSalesReader,
} from '../application/eligible-sales-reader.port';

/** Row shape produced by the explicit `select` below. */
interface EligibleSalesQueryRow {
  id: string;
  folio: string | null;
  status: string;
  paymentStatus: string | null;
  deliveryStatus: string;
  totalCents: number;
  debtCents: number;
  confirmedAt: Date | null;
  dueDate: Date | null;
  customer: {
    id: string;
    firstName: string;
    lastName: string | null;
    tenantId: string;
  } | null;
  shippingAddress:
    | (EligibleSaleAddressProjection & { tenantId: string })
    | null;
  items: { productName: string }[];
  deliveryRouteStops: {
    tenantId: string;
    routeId: string;
    route: {
      id: string;
      status: string;
      tenantId: string;
      driverUserId: string;
    };
  }[];
}

@Injectable()
export class PrismaEligibleSalesReader implements IEligibleSalesReader {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findEligibleSales(
    input: EligibleSalesReadInput,
  ): Promise<EligibleSalesPageProjection> {
    const prisma = this.tenantPrisma.getClient();

    const ands: Prisma.SaleWhereInput[] = [
      {
        tenantId: input.tenantId,
        status: 'CONFIRMED',
        deliveryStatus: { in: ['PENDING', 'SHIPPED'] },
      },
    ];
    if (input.saleScope) {
      ands.push(input.saleScope);
    }
    const term = input.q?.trim();
    if (term) {
      ands.push(buildEligibleSalesSearchWhere(term, input.tenantId));
    }
    const where: Prisma.SaleWhereInput = { AND: ands };

    const [rows, total] = await Promise.all([
      prisma.sale.findMany({
        where,
        orderBy: [
          { confirmedAt: { sort: 'desc', nulls: 'last' } },
          { id: 'desc' },
        ],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        select: {
          id: true,
          folio: true,
          status: true,
          paymentStatus: true,
          deliveryStatus: true,
          totalCents: true,
          debtCents: true,
          confirmedAt: true,
          dueDate: true,
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              tenantId: true,
            },
          },
          shippingAddress: {
            select: {
              id: true,
              tenantId: true,
              label: true,
              street: true,
              exteriorNumber: true,
              interiorNumber: true,
              neighborhood: true,
              municipality: true,
              city: true,
              state: true,
              zipCode: true,
            },
          },
          items: {
            select: { productName: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 3,
          },
          deliveryRouteStops: {
            where: {
              tenantId: input.tenantId,
              activeRouteId: { not: null },
            },
            orderBy: { sortOrder: 'asc' },
            select: {
              tenantId: true,
              routeId: true,
              route: {
                select: {
                  id: true,
                  status: true,
                  tenantId: true,
                  driverUserId: true,
                },
              },
            },
          },
        },
      }),
      prisma.sale.count({ where }),
    ]);

    // SAFETY: the explicit `select` above fixes exactly this projection; the
    // cast only re-states the shape Prisma returns (its inferred payload is a
    // structural superset) so the mapper stays readable and typed.
    const typedRows = rows as unknown as EligibleSalesQueryRow[];
    return {
      rows: typedRows.map((row) => this.mapRow(row, input.tenantId)),
      total,
    };
  }

  async findContextRoute(input: {
    tenantId: string;
    routeId: string;
  }): Promise<EligibleSalesContextRouteProjection | null> {
    const prisma = this.tenantPrisma.getClient();
    const route = await prisma.deliveryRoute.findFirst({
      where: { id: input.routeId, tenantId: input.tenantId },
      select: {
        id: true,
        status: true,
        driverUserId: true,
        stops: {
          where: { tenantId: input.tenantId },
          select: { id: true, tenantId: true, saleId: true, sortOrder: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!route) return null;
    return {
      id: route.id,
      status: route.status,
      driverUserId: route.driverUserId,
      stops: route.stops
        .filter((stop) => stop.tenantId === input.tenantId)
        .map((stop) => ({
          stopId: stop.id,
          saleId: stop.saleId,
          sortOrder: stop.sortOrder,
        })),
    };
  }

  private mapRow(
    row: EligibleSalesQueryRow,
    tenantId: string,
  ): EligibleSaleRowProjection {
    return {
      id: row.id,
      folio: row.folio,
      status: row.status,
      paymentStatus: row.paymentStatus,
      deliveryStatus: row.deliveryStatus,
      totalCents: row.totalCents,
      debtCents: row.debtCents,
      confirmedAt: row.confirmedAt,
      dueDate: row.dueDate,
      customer: this.mapCustomer(row.customer, tenantId),
      shippingAddress: this.mapAddress(row.shippingAddress, tenantId),
      productNames: row.items.map((item) => item.productName),
      occupancy: this.resolveOccupancy(row.deliveryRouteStops, tenantId),
    };
  }

  private mapCustomer(
    customer: EligibleSalesQueryRow['customer'],
    tenantId: string,
  ): EligibleSaleCustomerProjection | null {
    if (!customer || customer.tenantId !== tenantId) return null;
    return {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
    };
  }

  private mapAddress(
    address: EligibleSalesQueryRow['shippingAddress'],
    tenantId: string,
  ): EligibleSaleAddressProjection | null {
    if (!address || address.tenantId !== tenantId) return null;
    return {
      id: address.id,
      label: address.label,
      street: address.street,
      exteriorNumber: address.exteriorNumber,
      interiorNumber: address.interiorNumber,
      neighborhood: address.neighborhood,
      municipality: address.municipality,
      city: address.city,
      state: address.state,
      zipCode: address.zipCode,
    };
  }

  /**
   * The `activeRouteId` marker is the occupancy signal. A foreign-tenant
   * stop or route is dropped entirely (not occupancy); a same-tenant marker is kept
   * even when its status is outside `{DRAFT, ACTIVE}` so the sale is never
   * reported AVAILABLE. The most specific exposable route is preferred for
   * stable output when legacy duplicates exist.
   */
  private resolveOccupancy(
    stops: EligibleSalesQueryRow['deliveryRouteStops'],
    tenantId: string,
  ): EligibleSaleOccupancyProjection | null {
    const tenantStops = stops.filter(
      (stop) => stop.tenantId === tenantId && stop.route.tenantId === tenantId,
    );
    if (tenantStops.length === 0) return null;
    const exposable = tenantStops.find(
      (stop) => stop.route.status === 'DRAFT' || stop.route.status === 'ACTIVE',
    );
    const chosen = exposable ?? tenantStops[0];
    return {
      routeId: chosen.route.id,
      routeStatus: chosen.route.status,
      routeDriverUserId: chosen.route.driverUserId,
    };
  }
}

/**
 * `q` search clause. Numeric terms match the zero-padded folio suffix (the
 * same convention as `GET /sales`), everything else matches folio/last name/
 * address substrings case-insensitively.
 *
 * Every `customer` / `shippingAddress` branch carries the caller's
 * `tenantId`: the ambient tenant extension only scopes the top-level `sale`,
 * so without this a foreign-tenant related row could match the term and turn
 * the page/total into an existence oracle. The same `where` drives both
 * `findMany` and `count`.
 */
function buildEligibleSalesSearchWhere(
  term: string,
  tenantId: string,
): Prisma.SaleWhereInput {
  const or: Prisma.SaleWhereInput[] = [
    {
      customer: {
        tenantId,
        firstName: { contains: term, mode: 'insensitive' },
      },
    },
    {
      customer: {
        tenantId,
        lastName: { contains: term, mode: 'insensitive' },
      },
    },
    {
      shippingAddress: {
        tenantId,
        street: { contains: term, mode: 'insensitive' },
      },
    },
    {
      shippingAddress: {
        tenantId,
        neighborhood: { contains: term, mode: 'insensitive' },
      },
    },
    {
      shippingAddress: {
        tenantId,
        municipality: { contains: term, mode: 'insensitive' },
      },
    },
    {
      shippingAddress: {
        tenantId,
        city: { contains: term, mode: 'insensitive' },
      },
    },
    {
      shippingAddress: {
        tenantId,
        zipCode: { contains: term, mode: 'insensitive' },
      },
    },
  ];
  if (/^\d+$/.test(term)) {
    or.push({
      folio: { endsWith: term.padStart(6, '0'), mode: 'insensitive' },
    });
  } else {
    or.push({ folio: { contains: term, mode: 'insensitive' } });
  }
  return { OR: or };
}
