import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  Logger,
  NotFoundException,
  ParseUUIDPipe,
  RequestMethod,
  UnauthorizedException,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SalesQueryController } from './sales-query.controller';
import { SalesService } from './sales.service';
import { ListPendingRefundsQueryDto } from './dto/list-pending-refunds-query.dto';
import type { PendingRefundListResponseDto } from './dto/pending-refund-response.dto';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../auth/authorization/decorators/require-permissions.decorator';
import { createListingValidationExceptionFactory } from '../shared/listing/listing-validation-exception.factory';

function makeMockSalesService() {
  return {
    listSales: jest.fn(),
    listPendingRefunds: jest.fn(),
    getSaleDetail: jest.fn(),
    setDueDate: jest.fn(),
    assignSeller: jest.fn(),
    clearSeller: jest.fn(),
    cancelSale: jest.fn(),
  } as any;
}

function makeMockUser(userId: string): AuthenticatedUser {
  return {
    userId,
    email: `${userId}@test.com`,
    tenantId: null,
    tenantSlug: null,
    isSuperAdmin: false,
  };
}

describe('SalesQueryController', () => {
  let service: ReturnType<typeof makeMockSalesService>;
  let controller: SalesQueryController;

  beforeEach(() => {
    service = makeMockSalesService();
    controller = new SalesQueryController(service as SalesService);
  });

  it('delegates GET /sales query to service', async () => {
    const response = {
      data: [{ id: 'sale-1', folio: 'V-0001' }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      counts: { all: 1, pendingPayments: 0, notDelivered: 0 },
    };
    service.listSales.mockResolvedValue(response);
    const query = {
      page: 1,
      limit: 20,
      q: '0001',
      resolveLegacyAlias: jest.fn(),
    };

    const result = await controller.list(query as any);

    expect(result).toEqual(response);
    expect(query.resolveLegacyAlias).toHaveBeenCalled();
    expect(service.listSales).toHaveBeenCalledWith(query);
  });

  it('delegates GET /sales/:id to service', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const response = { id, folio: 'V-0002' };
    service.getSaleDetail.mockResolvedValue(response);

    const result = await controller.detail(id);

    expect(result).toEqual(response);
    expect(service.getSaleDetail).toHaveBeenCalledWith(id);
  });

  it('delegates 404 errors from service without masking', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const error = new Error('Sale not found');
    service.getSaleDetail.mockRejectedValue(error);

    await expect(controller.detail(id)).rejects.toThrow('Sale not found');
  });

  it('rejects invalid UUID format for GET /sales/:id param', async () => {
    const pipe = new ParseUUIDPipe();
    await expect(
      pipe.transform('not-a-uuid', {
        type: 'param',
        metatype: String,
        data: 'id',
      }),
    ).rejects.toThrow();
  });

  it('delegates PATCH /sales/:id/due-date to service', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const dto = { dueDate: '2026-07-01T00:00:00.000Z' };
    const response = { id, dueDate: dto.dueDate };
    service.setDueDate.mockResolvedValue(response);

    const result = await controller.setDueDate(id, dto);

    expect(result).toEqual(response);
    expect(service.setDueDate).toHaveBeenCalledWith(id, dto);
  });

  it('delegates PUT /sales/:id/seller to service', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const dto = { sellerUserId: '8fb23d4c-93ca-4528-8cc1-fdc2443ad621' };
    const response = { id, seller: { id: dto.sellerUserId, name: 'Seller' } };
    service.assignSeller.mockResolvedValue(response);
    const user = makeMockUser('actor-1');

    const result = await controller.assignSeller(id, dto, user);

    expect(result).toEqual(response);
    expect(service.assignSeller).toHaveBeenCalledWith(id, 'actor-1', dto);
  });

  it('delegates DELETE /sales/:id/seller to service and returns 204 contract', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    service.clearSeller.mockResolvedValue(undefined);
    const user = makeMockUser('actor-1');

    const result = await controller.clearSeller(id, user);

    expect(result).toBeUndefined();
    expect(service.clearSeller).toHaveBeenCalledWith(id, 'actor-1');
  });

  it('forwards seller-assignment service errors', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const dto = { sellerUserId: '8fb23d4c-93ca-4528-8cc1-fdc2443ad621' };
    const user = makeMockUser('actor-1');
    service.assignSeller.mockRejectedValue(new Error('SELLER_NOT_FOUND'));

    await expect(controller.assignSeller(id, dto, user)).rejects.toThrow(
      'SELLER_NOT_FOUND',
    );
  });

  // ── D.1.2 / D.1.4 cancel unit tests ──────────────────────────────────────

  it('POST /sales/:id/cancel — delegates to cancelSale and returns result', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const user = makeMockUser('user-1');
    const dto = { reason: 'CUSTOMER_REQUEST' as const };
    const expected = {
      saleId: id,
      status: 'CANCELED',
      refundedCents: 1000,
      restockedItems: [],
      canceledAt: '2026-06-23T00:00:00.000Z',
    };
    service.cancelSale.mockResolvedValue(expected);

    const result = await controller.cancelSale(id, dto as any, user);

    expect(result).toEqual(expected);
    expect(service.cancelSale).toHaveBeenCalledWith(id, 'user-1', dto);
  });

  it('POST /sales/:id/cancel — forwards service errors without masking', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const user = makeMockUser('user-1');
    service.cancelSale.mockRejectedValue(new Error('SALE_NOT_CANCELLABLE'));

    await expect(
      controller.cancelSale(id, { reason: 'OTHER' } as any, user),
    ).rejects.toThrow('SALE_NOT_CANCELLABLE');
  });

  it('POST /sales/:id/cancel — forwards SALE_DELIVERED_CANNOT_CANCEL error', async () => {
    const id = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
    const user = makeMockUser('user-1');
    service.cancelSale.mockRejectedValue(
      new Error('SALE_DELIVERED_CANNOT_CANCEL'),
    );

    await expect(
      controller.cancelSale(id, { reason: 'OTHER' } as any, user),
    ).rejects.toThrow('SALE_DELIVERED_CANNOT_CANCEL');
  });
});

describe('SalesQueryController HTTP integration', () => {
  const tenantACustomerId = '8a7cbe67-7e82-4d3c-b8d0-5f0e613c1a7a';
  const tenantBCustomerId = '1f6664aa-7f1d-43b6-96ca-3ef97a8f98cc';
  let app: INestApplication;
  let service: ReturnType<typeof makeMockSalesService>;

  class TestJwtAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      const auth = req.headers.authorization as string | undefined;
      if (!auth) throw new UnauthorizedException('Unauthorized');

      const token = auth.replace('Bearer ', '');
      if (token === 'tenant-a-read-sale') {
        req.user = {
          userId: 'user-a',
          tenantId: 'tenant-a',
          tenantSlug: 'tenant-a',
          isSuperAdmin: false,
          permissions: ['read:Sale'],
        };
        return true;
      }

      if (token === 'tenant-a-no-read-sale') {
        req.user = {
          userId: 'user-a',
          tenantId: 'tenant-a',
          tenantSlug: 'tenant-a',
          isSuperAdmin: false,
          permissions: [],
        };
        return true;
      }

      if (token === 'tenant-a-delete-sale') {
        req.user = {
          userId: 'user-a',
          tenantId: 'tenant-a',
          tenantSlug: 'tenant-a',
          isSuperAdmin: false,
          permissions: ['read:Sale', 'delete:Sale', 'read:SaleRefund'],
        };
        return true;
      }

      throw new UnauthorizedException('Unauthorized');
    }
  }

  class TestTenantGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      if (!req.user?.tenantId) {
        throw new UnauthorizedException('Tenant context required');
      }
      return true;
    }
  }

  class TestPermissionsGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      const permissions = (req.user?.permissions ?? []) as string[];
      const path = req.path as string;

      // prf-3 — the pending-refund listing is guarded by read:SaleRefund
      // and must NOT be satisfied by read:Sale alone.
      if (path.endsWith('/sales/refunds/pending')) {
        if (!permissions.includes('read:SaleRefund')) {
          throw new ForbiddenException('Insufficient permissions');
        }
        return true;
      }

      // cancel route requires delete:Sale
      if (path.endsWith('/cancel')) {
        if (!permissions.includes('delete:Sale')) {
          throw new ForbiddenException('Insufficient permissions');
        }
        return true;
      }

      if (!permissions.includes('read:Sale')) {
        throw new ForbiddenException('Insufficient permissions');
      }
      return true;
    }
  }

  beforeEach(async () => {
    service = makeMockSalesService();

    const moduleRef = await Test.createTestingModule({
      controllers: [SalesQueryController],
      providers: [{ provide: SalesService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard as Type<CanActivate>)
      .overrideGuard(TenantContextGuard)
      .useClass(TestTenantGuard as Type<CanActivate>)
      .overrideGuard(PermissionsGuard)
      .useClass(TestPermissionsGuard as Type<CanActivate>)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: createListingValidationExceptionFactory(),
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('canonical combined-filter scenario returns filtered sales and KPI base counts', async () => {
    service.listSales.mockImplementation(async (query) => {
      expect(query.paymentStatus).toEqual(['PAID', 'CREDIT']);
      expect(query.paymentMethod).toEqual(['CASH', 'TRANSFER']);
      expect(query.totalMin).toBe(50000);
      expect(query.totalMax).toBe(200000);
      expect(query.customerId).toEqual([tenantACustomerId]);
      expect(query.customerIncludeNull).toBe(true);
      expect(query.deliveryStatus).toEqual(['DELIVERED']);
      expect(query.q).toBe('Juan');

      return {
        data: [
          {
            id: 'sale-match-1',
            customer: { id: tenantACustomerId, name: 'Juan Perez' },
            paymentStatus: 'PAID',
            paymentMethod: 'CASH',
            deliveryStatus: 'DELIVERED',
            totalCents: 120000,
          },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        counts: { all: 3, pendingPayments: 1, notDelivered: 1 },
      };
    });

    const res = await request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .query({
        paymentStatus: 'PAID,CREDIT',
        paymentMethod: 'CASH,TRANSFER',
        totalMin: '50000',
        totalMax: '200000',
        dueDateFrom: '2026-06-01',
        dueDateTo: '2026-06-30',
        customerId: tenantACustomerId,
        customerIncludeNull: 'true',
        deliveryStatus: 'DELIVERED',
        q: 'Juan',
      })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].customer.name).toContain('Juan');
    expect(res.body.counts).toEqual({
      all: 3,
      pendingPayments: 1,
      notDelivered: 1,
    });
  });

  it('returns 401 when JWT is missing', async () => {
    await request(app.getHttpServer()).get('/sales').expect(401);
  });

  it('returns 403 when user lacks read:Sale permission', async () => {
    await request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', 'Bearer tenant-a-no-read-sale')
      .expect(403);
  });

  it('returns empty list when tenant A filters by tenant B customer', async () => {
    service.listSales.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      counts: { all: 0, pendingPayments: 0, notDelivered: 0 },
    });

    const res = await request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .query({ customerId: tenantBCustomerId })
      .expect(200);

    expect(service.listSales).toHaveBeenCalled();
    expect(res.body.data).toEqual([]);
  });

  it('accepts legacy from alias and maps to confirmedFrom with deprecation log', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    service.listSales.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      counts: { all: 0, pendingPayments: 0, notDelivered: 0 },
    });

    await request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .query({ from: '2026-01-01' })
      .expect(200);

    const calledQuery = service.listSales.mock.calls[0][0];
    expect(calledQuery.confirmedFrom).toEqual(new Date('2026-01-01'));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[DEPRECATION] sales-list query used legacy from/to alias',
    );
  });

  it('emits deprecation warning exactly once per request when using legacy from', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    service.listSales.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      counts: { all: 0, pendingPayments: 0, notDelivered: 0 },
    });

    await request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .query({ from: '2026-01-01' })
      .expect(200);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('prefers confirmedFrom over legacy from and still logs deprecation', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    service.listSales.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      counts: { all: 0, pendingPayments: 0, notDelivered: 0 },
    });

    await request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .query({ from: '2026-01-01', confirmedFrom: '2026-02-01' })
      .expect(200);

    const calledQuery = service.listSales.mock.calls[0][0];
    expect(calledQuery.confirmedFrom).toEqual(new Date('2026-02-01'));
    expect(warnSpy).toHaveBeenCalledWith(
      '[DEPRECATION] sales-list query used legacy from/to alias',
    );
  });

  it('returns LISTING_INVALID_ENUM_VALUE for invalid enum value', async () => {
    const res = await request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .query({ paymentStatus: 'INVALID' })
      .expect(400);

    expect(res.body.code).toBe('LISTING_INVALID_ENUM_VALUE');
    expect(res.body.field).toBe('paymentStatus');
  });

  it('returns LISTING_INVERTED_RANGE for inverted numeric range', async () => {
    const res = await request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .query({ totalMin: '200', totalMax: '50' })
      .expect(400);

    expect(res.body.code).toBe('LISTING_INVERTED_RANGE');
  });

  it('returns LISTING_INVERTED_RANGE for inverted confirmed date range', async () => {
    const res = await request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .query({ confirmedFrom: '2026-12-31', confirmedTo: '2026-01-01' })
      .expect(400);

    expect(res.body.code).toBe('LISTING_INVERTED_RANGE');
  });

  it('returns LISTING_TOO_MANY_VALUES when customerId cardinality exceeds cap', async () => {
    const ids = Array.from(
      { length: 201 },
      (_, index) =>
        `${(index + 1).toString().padStart(8, '0')}-1234-4234-9234-1234567890ab`,
    );

    const res = await request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .query({ customerId: ids.join(',') })
      .expect(400);

    expect(res.body.code).toBe('LISTING_TOO_MANY_VALUES');
    expect(res.body.details?.cap).toBe(200);
  });

  // ── D.1.2 / D.1.4 cancel HTTP integration tests ───────────────────────────

  const cancelSaleId = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
  const cancelBody = { reason: 'CUSTOMER_REQUEST' };
  const cancelResult = {
    saleId: cancelSaleId,
    status: 'CANCELED',
    refundedCents: 1000,
    restockedItems: [],
    canceledAt: '2026-06-23T00:00:00.000Z',
  };

  it('POST /sales/:id/cancel returns 403 when delete:Sale permission is missing', async () => {
    await request(app.getHttpServer())
      .post(`/sales/${cancelSaleId}/cancel`)
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .send(cancelBody)
      .expect(403);
  });

  it('POST /sales/:id/cancel returns 200 and cancel result for authorized user', async () => {
    service.cancelSale.mockResolvedValue(cancelResult);

    await request(app.getHttpServer())
      .post(`/sales/${cancelSaleId}/cancel`)
      .set('Authorization', 'Bearer tenant-a-delete-sale')
      .send(cancelBody)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(service.cancelSale).toHaveBeenCalledWith(
          cancelSaleId,
          'user-a',
          cancelBody,
        );
        expect(body).toEqual(cancelResult);
      });
  });

  it('POST /sales/:id/cancel returns 400 for invalid reason enum value', async () => {
    await request(app.getHttpServer())
      .post(`/sales/${cancelSaleId}/cancel`)
      .set('Authorization', 'Bearer tenant-a-delete-sale')
      .send({ reason: 'INVALID_REASON' })
      .expect(400);
  });

  it('POST /sales/:id/cancel propagates ConflictException (invalid state)', async () => {
    service.cancelSale.mockRejectedValue(
      new ConflictException('SALE_NOT_CANCELLABLE'),
    );

    await request(app.getHttpServer())
      .post(`/sales/${cancelSaleId}/cancel`)
      .set('Authorization', 'Bearer tenant-a-delete-sale')
      .send(cancelBody)
      .expect(409);
  });

  it('POST /sales/:id/cancel propagates NotFoundException (not found)', async () => {
    service.cancelSale.mockRejectedValue(
      new NotFoundException('Sale not found'),
    );

    await request(app.getHttpServer())
      .post(`/sales/${cancelSaleId}/cancel`)
      .set('Authorization', 'Bearer tenant-a-delete-sale')
      .send(cancelBody)
      .expect(404);
  });

  // ── prf-3 pending refund listing HTTP integration tests ─────────────────

  const pendingRefundPage: PendingRefundListResponseDto = {
    data: [
      {
        id: 'refund-1',
        saleId: 'sale-1',
        method: 'cash',
        amountCents: 1500,
        reason: 'CUSTOMER_REQUEST',
        status: 'PENDING',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  };

  it('GET /sales/refunds/pending returns 200 and forwards the validated query', async () => {
    pendingRefundsMockOf(service).mockResolvedValue(pendingRefundPage);

    const res = await request(app.getHttpServer())
      .get('/sales/refunds/pending')
      .set('Authorization', 'Bearer tenant-a-delete-sale')
      .expect(200);

    const body: unknown = res.body;
    // JSON boundary: `createdAt` crosses the wire as an ISO string.
    expect(body).toEqual({
      data: [
        {
          id: 'refund-1',
          saleId: 'sale-1',
          method: 'cash',
          amountCents: 1500,
          reason: 'CUSTOMER_REQUEST',
          status: 'PENDING',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
    expect(pendingRefundsMockOf(service)).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
    });
  });

  it('GET /sales/refunds/pending returns an empty page with 200, never 404', async () => {
    pendingRefundsMockOf(service).mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });

    const res = await request(app.getHttpServer())
      .get('/sales/refunds/pending')
      .set('Authorization', 'Bearer tenant-a-delete-sale')
      .expect(200);

    const body: unknown = res.body;
    const page = body as PendingRefundListResponseDto;
    expect(page.data).toEqual([]);
    expect(page.pagination.totalPages).toBe(0);
  });

  it('GET /sales/refunds/pending returns 401 when JWT is missing', async () => {
    await request(app.getHttpServer())
      .get('/sales/refunds/pending')
      .expect(401);
  });

  it('GET /sales/refunds/pending returns 403 for read:Sale without read:SaleRefund', async () => {
    // `tenant-a-read-sale` holds exactly ['read:Sale'], which is enough for
    // the other sales query routes but must NOT authorize this one.
    await request(app.getHttpServer())
      .get('/sales/refunds/pending')
      .set('Authorization', 'Bearer tenant-a-read-sale')
      .expect(403);

    expect(pendingRefundsMockOf(service)).not.toHaveBeenCalled();
  });

  it('GET /sales/refunds/pending returns 400 for an out-of-bounds limit', async () => {
    await request(app.getHttpServer())
      .get('/sales/refunds/pending')
      .set('Authorization', 'Bearer tenant-a-delete-sale')
      .query({ limit: '101' })
      .expect(400);

    expect(pendingRefundsMockOf(service)).not.toHaveBeenCalled();
  });
});

/**
 * prf-3 — typed double for the pending-refund listing. The legacy
 * `makeMockSalesService` above is `any`-typed for the pre-existing
 * suite; new tests build their own narrow, type-checked double instead
 * of widening that one.
 */
type PendingRefundSalesServiceMock = {
  listSales: jest.Mock;
  listPendingRefunds: jest.Mock<
    Promise<PendingRefundListResponseDto>,
    [ListPendingRefundsQueryDto]
  >;
  getSaleDetail: jest.Mock;
  setDueDate: jest.Mock;
  assignSeller: jest.Mock;
  clearSeller: jest.Mock;
  cancelSale: jest.Mock;
};

function makeTypedSalesServiceMock(): PendingRefundSalesServiceMock {
  return {
    listSales: jest.fn(),
    listPendingRefunds: jest.fn<
      Promise<PendingRefundListResponseDto>,
      [ListPendingRefundsQueryDto]
    >(),
    getSaleDetail: jest.fn(),
    setDueDate: jest.fn(),
    assignSeller: jest.fn(),
    clearSeller: jest.fn(),
    cancelSale: jest.fn(),
  };
}

/**
 * Narrow, type-checked handle onto the pending-refund mock held by the
 * `any`-typed app-level double, so assertions stay checked without
 * rewriting the pre-existing HTTP suite.
 */
function pendingRefundsMockOf(
  service: unknown,
): PendingRefundSalesServiceMock['listPendingRefunds'] {
  return (service as PendingRefundSalesServiceMock).listPendingRefunds;
}

describe('SalesQueryController — GET /sales/refunds/pending wiring (prf-3)', () => {
  const pendingRefundPage: PendingRefundListResponseDto = {
    data: [
      {
        id: 'refund-1',
        saleId: 'sale-1',
        method: 'cash',
        amountCents: 1500,
        reason: 'CUSTOMER_REQUEST',
        status: 'PENDING',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  };

  const handlerOf = (method: string): object => {
    const descriptor = Object.getOwnPropertyDescriptor(
      SalesQueryController.prototype,
      method,
    );
    const handler = descriptor?.value as object | undefined;
    expect(handler).toBeDefined();
    return handler as object;
  };

  const routeIndexOf = (path: string): number =>
    Object.getOwnPropertyNames(SalesQueryController.prototype).findIndex(
      (name) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          SalesQueryController.prototype,
          name,
        );
        const handler = descriptor?.value as object | undefined;
        return (
          handler !== undefined &&
          Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.GET &&
          Reflect.getMetadata(PATH_METADATA, handler) === path
        );
      },
    );

  it('delegates the validated query to the service', async () => {
    const service = makeTypedSalesServiceMock();
    service.listPendingRefunds.mockResolvedValue(pendingRefundPage);
    const controller = new SalesQueryController(
      service as unknown as SalesService,
    );
    const query = new ListPendingRefundsQueryDto();

    const result = await controller.listPendingRefunds(query);

    expect(result).toEqual(pendingRefundPage);
    expect(service.listPendingRefunds).toHaveBeenCalledWith(query);
    expect(service.listSales).not.toHaveBeenCalled();
  });

  it('forwards service failures without masking', async () => {
    const service = makeTypedSalesServiceMock();
    service.listPendingRefunds.mockRejectedValue(
      new Error('TENANT_CONTEXT_REQUIRED'),
    );
    const controller = new SalesQueryController(
      service as unknown as SalesService,
    );

    await expect(
      controller.listPendingRefunds(new ListPendingRefundsQueryDto()),
    ).rejects.toThrow('TENANT_CONTEXT_REQUIRED');
  });

  it('requires exactly the SaleRefund read permission', () => {
    const perms = Reflect.getMetadata(
      PERMISSIONS_KEY,
      handlerOf('listPendingRefunds'),
    ) as Array<[string, string]> | undefined;

    expect(perms).toEqual([['read', 'SaleRefund']]);
  });

  it('is mapped to GET /sales/refunds/pending', () => {
    const handler = handlerOf('listPendingRefunds');

    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('refunds/pending');
  });

  it('declares the static refunds/pending route before the parameterized :id route', () => {
    const staticIndex = routeIndexOf('refunds/pending');
    const parameterizedIndex = routeIndexOf(':id');

    expect(staticIndex).toBeGreaterThanOrEqual(0);
    expect(parameterizedIndex).toBeGreaterThanOrEqual(0);
    expect(staticIndex).toBeLessThan(parameterizedIndex);
  });
});
