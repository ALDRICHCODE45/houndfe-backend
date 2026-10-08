/**
 * APPLICATION SPEC: EligibleSalesService — delivery-routes / T4.
 *
 * Exercises the selector through the service public interface with a
 * mocked reader:
 *   - permission gate (`read:Sale` AND route-manager `create:DeliveryRoute`)
 *   - CASL Sale row scope translation handed to the reader
 *   - pagination envelope (`page`/`limit` defaults, `totalPages`)
 *   - search passthrough
 *   - `contextRouteId` validation (tenant-scoped + instance-authorized)
 *   - availability inference: AVAILABLE / INELIGIBLE / OCCUPIED /
 *     IN_CURRENT_ROUTE and the precedence between them
 *   - occupancy redaction when the caller cannot read the route instance
 *     (never downgraded to AVAILABLE)
 */
import { createMongoAbility } from '@casl/ability';
import {
  InsufficientPermissionsError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import { DeliveryRouteNotFoundError } from '../domain/delivery-route.errors';
import { EligibleSalesService } from './eligible-sales.service';
import type { EligibleSalesRequestContext } from './eligible-sales.service';
import type {
  EligibleSaleRowProjection,
  EligibleSalesPageProjection,
  IEligibleSalesReader,
} from './eligible-sales-reader.port';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { EligibleSalesQueryDto } from '../dto/eligible-sales-query.dto';

const TENANT_ID = 'tenant-1';
const CONTEXT_ROUTE_ID = '9f0f4b0a-6b1e-4f5d-9c8a-2d4e6f8a1b3c';
const NOW = new Date('2026-08-01T12:00:00.000Z');

const ability = (rules: unknown[]): AppAbility =>
  createMongoAbility(rules as never) as unknown as AppAbility;

const ROUTE_MANAGER_RULES: unknown[] = [
  { action: 'read', subject: 'Sale' },
  { action: 'create', subject: 'DeliveryRoute' },
  { action: 'read', subject: 'DeliveryRoute' },
];

const makeCtx = (
  rules: unknown[] = ROUTE_MANAGER_RULES,
): EligibleSalesRequestContext => ({
  userId: 'user-1',
  ability: ability(rules),
});

const makeRow = (
  overrides: Partial<EligibleSaleRowProjection> = {},
): EligibleSaleRowProjection => ({
  id: 'sale-1',
  folio: 'F-0001',
  status: 'CONFIRMED',
  paymentStatus: 'PAID',
  deliveryStatus: 'PENDING',
  totalCents: 10000,
  debtCents: 0,
  confirmedAt: NOW,
  dueDate: null,
  customer: { id: 'cust-1', firstName: 'Ana', lastName: 'López' },
  shippingAddress: {
    id: 'addr-1',
    label: null,
    street: 'Calle 1',
    exteriorNumber: '10',
    interiorNumber: null,
    neighborhood: 'Centro',
    municipality: 'Benito Juárez',
    city: 'CDMX',
    state: 'CDMX',
    zipCode: '03100',
  },
  productNames: ['Café', 'Té'],
  occupancy: null,
  ...overrides,
});

const makeQuery = (
  overrides: Partial<EligibleSalesQueryDto> = {},
): EligibleSalesQueryDto =>
  Object.assign(new EligibleSalesQueryDto(), overrides);

const makeHarness = (page: Partial<EligibleSalesPageProjection> = {}) => {
  const reader = {
    findEligibleSales: jest.fn(),
    findContextRoute: jest.fn(),
  };
  reader.findEligibleSales.mockResolvedValue({
    rows: page.rows ?? [],
    total: page.total ?? 0,
  });
  reader.findContextRoute.mockResolvedValue(null);
  const cls = {
    get: jest.fn(() => ({ tenantId: TENANT_ID, isSuperAdmin: false })),
  } as unknown as ClsService<TenantClsStore>;
  const service = new EligibleSalesService(
    reader as unknown as IEligibleSalesReader,
    cls,
  );
  return { service, reader, cls };
};

describe('EligibleSalesService.list', () => {
  it('rejects a caller without read:Sale', async () => {
    const { service } = makeHarness();
    const ctx = makeCtx([{ action: 'create', subject: 'DeliveryRoute' }]);

    await expect(service.list(ctx, makeQuery())).rejects.toBeInstanceOf(
      InsufficientPermissionsError,
    );
  });

  it('rejects a caller without route-manager create:DeliveryRoute', async () => {
    const { service } = makeHarness();
    const ctx = makeCtx([{ action: 'read', subject: 'Sale' }]);

    await expect(service.list(ctx, makeQuery())).rejects.toBeInstanceOf(
      InsufficientPermissionsError,
    );
  });

  it('requires tenant context', async () => {
    const { service, cls } = makeHarness();
    (cls.get as jest.Mock).mockReturnValue({
      tenantId: null,
      isSuperAdmin: false,
    });

    await expect(service.list(makeCtx(), makeQuery())).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it('maps a confirmed sale with address to AVAILABLE with the exact scalar types', async () => {
    const { service } = makeHarness({ rows: [makeRow()], total: 1 });

    const response = await service.list(makeCtx(), makeQuery());

    expect(response.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
    expect(response.data).toHaveLength(1);
    const row = response.data[0];
    expect(row).toEqual({
      id: 'sale-1',
      folio: 'F-0001',
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
      deliveryStatus: 'PENDING',
      totalCents: 10000,
      debtCents: 0,
      confirmedAt: '2026-08-01T12:00:00.000Z',
      dueDate: null,
      customer: { id: 'cust-1', name: 'Ana López' },
      shippingAddress: {
        id: 'addr-1',
        label: null,
        street: 'Calle 1',
        exteriorNumber: '10',
        interiorNumber: null,
        neighborhood: 'Centro',
        municipality: 'Benito Juárez',
        city: 'CDMX',
        state: 'CDMX',
        zipCode: '03100',
      },
      productSummary: ['Café', 'Té'],
      availability: { state: 'AVAILABLE' },
    });
  });

  it('marks a sale without a shipping address INELIGIBLE MISSING_ADDRESS', async () => {
    const { service } = makeHarness({
      rows: [makeRow({ shippingAddress: null })],
      total: 1,
    });

    const response = await service.list(makeCtx(), makeQuery());

    expect(response.data[0].availability).toEqual({
      state: 'INELIGIBLE',
      reason: 'MISSING_ADDRESS',
    });
  });

  it('marks a non-deliverable delivery status INELIGIBLE DELIVERY_STATUS', async () => {
    const { service } = makeHarness({
      rows: [makeRow({ deliveryStatus: 'DELIVERED' })],
      total: 1,
    });

    const response = await service.list(makeCtx(), makeQuery());

    expect(response.data[0].availability).toEqual({
      state: 'INELIGIBLE',
      reason: 'DELIVERY_STATUS',
    });
  });

  it('exposes occupiedRoute when the caller can read the route instance', async () => {
    const { service } = makeHarness({
      rows: [
        makeRow({
          occupancy: {
            routeId: 'route-9',
            routeStatus: 'ACTIVE',
            routeDriverUserId: 'driver-9',
          },
        }),
      ],
      total: 1,
    });

    const response = await service.list(makeCtx(), makeQuery());

    expect(response.data[0].availability).toEqual({
      state: 'OCCUPIED',
      reason: 'RESERVED_BY_ROUTE',
      occupiedRoute: { id: 'route-9', status: 'ACTIVE' },
    });
  });

  it('redacts occupiedRoute but keeps OCCUPIED when the caller cannot read the instance', async () => {
    const { service } = makeHarness({
      rows: [
        makeRow({
          occupancy: {
            routeId: 'route-9',
            routeStatus: 'DRAFT',
            routeDriverUserId: 'other-driver',
          },
        }),
      ],
      total: 1,
    });
    const ctx = makeCtx([
      { action: 'read', subject: 'Sale' },
      { action: 'create', subject: 'DeliveryRoute' },
      {
        action: 'read',
        subject: 'DeliveryRoute',
        conditions: { driverUserId: 'me' },
      },
    ]);

    const response = await service.list(ctx, makeQuery());

    expect(response.data[0].availability).toEqual({
      state: 'OCCUPIED',
      reason: 'RESERVED_BY_ROUTE',
      occupiedRoute: null,
    });
  });

  it('does not treat a malformed occupancy status as available', async () => {
    const { service } = makeHarness({
      rows: [
        makeRow({
          occupancy: {
            routeId: 'route-9',
            routeStatus: 'COMPLETED',
            routeDriverUserId: 'driver-9',
          },
        }),
      ],
      total: 1,
    });

    const response = await service.list(makeCtx(), makeQuery());

    expect(response.data[0].availability).toEqual({
      state: 'OCCUPIED',
      reason: 'RESERVED_BY_ROUTE',
      occupiedRoute: null,
    });
  });

  it('marks a context-route stop IN_CURRENT_ROUTE with its stop metadata', async () => {
    const { service, reader } = makeHarness({
      rows: [makeRow({ id: 'sale-1' })],
      total: 1,
    });
    reader.findContextRoute.mockResolvedValue({
      id: CONTEXT_ROUTE_ID,
      status: 'DRAFT',
      driverUserId: 'driver-9',
      stops: [
        { stopId: 'stop-a', saleId: 'sale-1', sortOrder: 2 },
        { stopId: 'stop-b', saleId: 'sale-1', sortOrder: 0 },
      ],
    });

    const response = await service.list(
      makeCtx(),
      makeQuery({ contextRouteId: CONTEXT_ROUTE_ID }),
    );

    expect(response.data[0].availability).toEqual({
      state: 'IN_CURRENT_ROUTE',
      stopId: 'stop-b',
      sortOrder: 0,
    });
  });

  it('prefers IN_CURRENT_ROUTE over an occupancy marker', async () => {
    const { service, reader } = makeHarness({
      rows: [
        makeRow({
          occupancy: {
            routeId: 'route-9',
            routeStatus: 'ACTIVE',
            routeDriverUserId: 'driver-9',
          },
        }),
      ],
      total: 1,
    });
    reader.findContextRoute.mockResolvedValue({
      id: CONTEXT_ROUTE_ID,
      status: 'DRAFT',
      driverUserId: 'driver-9',
      stops: [{ stopId: 'stop-a', saleId: 'sale-1', sortOrder: 1 }],
    });

    const response = await service.list(
      makeCtx(),
      makeQuery({ contextRouteId: CONTEXT_ROUTE_ID }),
    );

    expect(response.data[0].availability).toEqual({
      state: 'IN_CURRENT_ROUTE',
      stopId: 'stop-a',
      sortOrder: 1,
    });
  });

  it('marks an ACTIVE context-route stop IN_CURRENT_ROUTE', async () => {
    const { service, reader } = makeHarness({
      rows: [makeRow({ id: 'sale-1' })],
      total: 1,
    });
    reader.findContextRoute.mockResolvedValue({
      id: CONTEXT_ROUTE_ID,
      status: 'ACTIVE',
      driverUserId: 'driver-9',
      stops: [{ stopId: 'stop-a', saleId: 'sale-1', sortOrder: 3 }],
    });

    const response = await service.list(
      makeCtx(),
      makeQuery({ contextRouteId: CONTEXT_ROUTE_ID }),
    );

    expect(response.data[0].availability).toEqual({
      state: 'IN_CURRENT_ROUTE',
      stopId: 'stop-a',
      sortOrder: 3,
    });
  });

  it('does not treat a COMPLETED context route stop as current membership', async () => {
    const { service, reader } = makeHarness({
      rows: [makeRow({ id: 'sale-1' })],
      total: 1,
    });
    reader.findContextRoute.mockResolvedValue({
      id: CONTEXT_ROUTE_ID,
      status: 'COMPLETED',
      driverUserId: 'driver-9',
      stops: [{ stopId: 'stop-a', saleId: 'sale-1', sortOrder: 0 }],
    });

    const response = await service.list(
      makeCtx(),
      makeQuery({ contextRouteId: CONTEXT_ROUTE_ID }),
    );

    expect(response.data[0].availability).toEqual({ state: 'AVAILABLE' });
  });

  it('does not treat a CANCELLED context route stop as current membership', async () => {
    const { service, reader } = makeHarness({
      rows: [makeRow({ id: 'sale-1' })],
      total: 1,
    });
    reader.findContextRoute.mockResolvedValue({
      id: CONTEXT_ROUTE_ID,
      status: 'CANCELLED',
      driverUserId: 'driver-9',
      stops: [{ stopId: 'stop-a', saleId: 'sale-1', sortOrder: 0 }],
    });

    const response = await service.list(
      makeCtx(),
      makeQuery({ contextRouteId: CONTEXT_ROUTE_ID }),
    );

    expect(response.data[0].availability).toEqual({ state: 'AVAILABLE' });
  });

  it('keeps OCCUPIED when a historical context stop is also reserved by a live route', async () => {
    const { service, reader } = makeHarness({
      rows: [
        makeRow({
          id: 'sale-1',
          occupancy: {
            routeId: 'route-live',
            routeStatus: 'DRAFT',
            routeDriverUserId: 'driver-9',
          },
        }),
      ],
      total: 1,
    });
    reader.findContextRoute.mockResolvedValue({
      id: CONTEXT_ROUTE_ID,
      status: 'COMPLETED',
      driverUserId: 'driver-9',
      stops: [{ stopId: 'stop-a', saleId: 'sale-1', sortOrder: 0 }],
    });

    const response = await service.list(
      makeCtx(),
      makeQuery({ contextRouteId: CONTEXT_ROUTE_ID }),
    );

    expect(response.data[0].availability).toEqual({
      state: 'OCCUPIED',
      reason: 'RESERVED_BY_ROUTE',
      occupiedRoute: { id: 'route-live', status: 'DRAFT' },
    });
  });

  it('validates the context route existence/permission even when historical', async () => {
    const { service, reader } = makeHarness();
    reader.findContextRoute.mockResolvedValue({
      id: CONTEXT_ROUTE_ID,
      status: 'COMPLETED',
      driverUserId: 'other-driver',
      stops: [{ stopId: 'stop-a', saleId: 'sale-1', sortOrder: 0 }],
    });
    const ctx = makeCtx([
      { action: 'read', subject: 'Sale' },
      { action: 'create', subject: 'DeliveryRoute' },
      {
        action: 'read',
        subject: 'DeliveryRoute',
        conditions: { driverUserId: 'me' },
      },
    ]);

    await expect(
      service.list(ctx, makeQuery({ contextRouteId: CONTEXT_ROUTE_ID })),
    ).rejects.toBeInstanceOf(DeliveryRouteNotFoundError);
  });

  it('prefers INELIGIBLE over an occupancy marker', async () => {
    const { service } = makeHarness({
      rows: [
        makeRow({
          shippingAddress: null,
          occupancy: {
            routeId: 'route-9',
            routeStatus: 'ACTIVE',
            routeDriverUserId: 'driver-9',
          },
        }),
      ],
      total: 1,
    });

    const response = await service.list(makeCtx(), makeQuery());

    expect(response.data[0].availability).toEqual({
      state: 'INELIGIBLE',
      reason: 'MISSING_ADDRESS',
    });
  });

  it('throws 404 for a missing context route without leaking existence', async () => {
    const { service, reader } = makeHarness();
    reader.findContextRoute.mockResolvedValue(null);

    await expect(
      service.list(makeCtx(), makeQuery({ contextRouteId: CONTEXT_ROUTE_ID })),
    ).rejects.toBeInstanceOf(DeliveryRouteNotFoundError);
  });

  it('throws 404 when the caller cannot read the context route instance', async () => {
    const { service, reader } = makeHarness();
    reader.findContextRoute.mockResolvedValue({
      id: CONTEXT_ROUTE_ID,
      status: 'DRAFT',
      driverUserId: 'other-driver',
      stops: [],
    });
    const ctx = makeCtx([
      { action: 'read', subject: 'Sale' },
      { action: 'create', subject: 'DeliveryRoute' },
      {
        action: 'read',
        subject: 'DeliveryRoute',
        conditions: { driverUserId: 'me' },
      },
    ]);

    await expect(
      service.list(ctx, makeQuery({ contextRouteId: CONTEXT_ROUTE_ID })),
    ).rejects.toBeInstanceOf(DeliveryRouteNotFoundError);
  });

  it('does not look up a context route when none is supplied', async () => {
    const { service, reader } = makeHarness();

    await service.list(makeCtx(), makeQuery());

    expect(reader.findContextRoute).not.toHaveBeenCalled();
  });

  it('passes pagination and search to the reader and computes totalPages', async () => {
    const { service, reader } = makeHarness({ rows: [], total: 45 });

    const response = await service.list(
      makeCtx(),
      makeQuery({ page: 2, limit: 20, q: ' Ana ' }),
    );

    expect(reader.findEligibleSales).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        page: 2,
        limit: 20,
        q: ' Ana ',
      }),
    );
    expect(response.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
  });

  it('returns totalPages 0 for an empty result', async () => {
    const { service } = makeHarness({ rows: [], total: 0 });

    const response = await service.list(makeCtx(), makeQuery());

    expect(response.pagination.totalPages).toBe(0);
  });

  it('passes the CASL-derived Sale row scope to the reader', async () => {
    const { service, reader } = makeHarness();
    const ctx = makeCtx([
      { action: 'read', subject: 'Sale', conditions: { userId: 'u1' } },
      { action: 'create', subject: 'DeliveryRoute' },
    ]);

    await service.list(ctx, makeQuery());

    expect(reader.findEligibleSales).toHaveBeenCalledWith(
      expect.objectContaining({ saleScope: { userId: 'u1' } }),
    );
  });
});
