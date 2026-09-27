/**
 * bas-3b — HTTP contract for GET /analytics/sales/summary.
 * OI-2 / S4 extends this file with GET /analytics/sales/timeseries.
 *
 * In-memory Nest app + Supertest: the three guards become typed doubles (bearer
 * auth, tenant context, exact `read:Analytics` metadata), the services are
 * mocked with fixtures, and the global ValidationPipe mirrors `main.ts`. No DB.
 */
import {
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AnalyticsController } from './analytics.controller';
import { BranchSalesSummaryService } from '../application/branch-sales-summary.service';
import { BranchSalesTimeseriesService } from '../application/branch-sales-timeseries.service';
import { SellerSalesReportService } from '../application/seller-sales-report.service';
import {
  ANALYTICS_TIME_ZONE,
  type BranchSalesSummaryQueryDto,
} from '../dto/branch-sales-summary-query.dto';
import {
  BRANCH_SALES_TIMESERIES_RESPONSE_KEYS,
  BRANCH_SALES_TIMESERIES_POINT_KEYS,
  type BranchSalesTimeseriesPointDto,
  type BranchSalesTimeseriesResponseDto,
} from '../dto/branch-sales-timeseries-response.dto';
import type { BranchSalesTimeseriesQueryDto } from '../dto/branch-sales-timeseries-query.dto';
import {
  SELLER_SALES_REPORT_CANCELED_ROW_KEYS,
  SELLER_SALES_REPORT_CONFIRMED_ROW_KEYS,
  SELLER_SALES_REPORT_RESPONSE_KEYS,
  type SellerSalesReportResponseDto,
} from '../dto/seller-sales-report-response.dto';
import {
  BRANCH_SALES_SUMMARY_RESPONSE_KEYS,
  type BranchSalesSummaryResponseDto,
} from '../dto/branch-sales-summary-response.dto';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type {
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { SellerNotFoundError } from '../../sales/domain/sale.errors';
import { SellerReportRowLimitExceededError } from '../domain/seller-sales-report.repository';

type PermissionTuple = readonly [AppActions, AppSubjects];

/** Test principal: `AuthenticatedUser` plus the granted permission tuples. */
interface AnalyticsTestPrincipal extends AuthenticatedUser {
  permissions: PermissionTuple[];
}

/** Typed view of the HTTP request the test guards read and populate. */
interface AnalyticsTestRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AnalyticsTestPrincipal;
}

const requestOf = (context: ExecutionContext): AnalyticsTestRequest =>
  context.switchToHttp().getRequest<AnalyticsTestRequest>();

/** Handler-first permission metadata, falling back to class-level metadata. */
const requiredPermissionsOf = (context: ExecutionContext): PermissionTuple[] =>
  (Reflect.getMetadata(PERMISSIONS_KEY, context.getHandler()) ??
    Reflect.getMetadata(PERMISSIONS_KEY, context.getClass()) ??
    []) as PermissionTuple[];

const principal = (
  userId: string,
  permissions: PermissionTuple[],
): AnalyticsTestPrincipal => ({
  userId,
  email: `${userId}@houndfe.test`,
  tenantId: 'tenant-analytics',
  tenantSlug: 'tenant-analytics',
  isSuperAdmin: false,
  permissions,
});

/** Bearer token -> principal fixture; the token names the permission set. */
const PRINCIPALS: Record<string, AnalyticsTestPrincipal> = {
  'tenant-analytics-reader': principal('analytics-reader', [
    ['read', 'Analytics'],
  ]),
  'tenant-sale-reader': principal('sale-reader', [['read', 'Sale']]),
  'tenant-analytics-sale-reader': principal('analytics-sale-reader', [
    ['read', 'Analytics'],
    ['read', 'Sale'],
  ]),
};

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = requestOf(context);
    const header = request.headers.authorization;
    const bearer = Array.isArray(header) ? header[0] : header;
    const token = bearer?.startsWith('Bearer ')
      ? bearer.slice('Bearer '.length)
      : undefined;
    const user = token ? PRINCIPALS[token] : undefined;
    if (!user) {
      throw new UnauthorizedException('Bearer authentication required');
    }
    request.user = user;
    return true;
  }
}

class TestTenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = requestOf(context).user;
    if (!user?.tenantId && !user?.isSuperAdmin) {
      throw new UnauthorizedException('Tenant context required');
    }
    return true;
  }
}

class TestPermissionsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const required = requiredPermissionsOf(context);
    if (required.length === 0) return true;
    const user = requestOf(context).user;
    if (!user) {
      throw new UnauthorizedException('User not authenticated');
    }
    const granted = user.permissions;
    const allowed = required.every(([action, subject]) =>
      granted.some(
        ([grantedAction, grantedSubject]) =>
          (grantedAction === action && grantedSubject === subject) ||
          (grantedAction === 'manage' && grantedSubject === 'all'),
      ),
    );
    if (!allowed) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}

const RANGE = { from: '2026-01-01', to: '2026-02-01' } as const;

const SELLER_ID = '11111111-1111-4111-8111-111111111111';

const SELLER_REPORT_RESPONSE: SellerSalesReportResponseDto = {
  seller: { id: SELLER_ID, name: 'Vendedor Uno' },
  tenantId: 'tenant-analytics',
  timeZone: ANALYTICS_TIME_ZONE,
  from: RANGE.from,
  to: RANGE.to,
  generatedAt: '2026-03-01T12:00:00.000Z',
  attribution: 'CURRENT_SELLER',
  balances: 'CURRENT',
  rowLimit: 1000,
  rowCount: 2,
  confirmed: {
    dateBasis: 'confirmedAt',
    summary: {
      saleCount: 1,
      netSalesCents: 10_000,
      collectedCents: 4_000,
      outstandingDebtCents: 6_000,
      averageTicketCents: 10_000,
    },
    rows: [
      {
        id: 'sale-1',
        folio: 'A-1',
        confirmedAt: '2026-01-05T18:30:00.000Z',
        totalCents: 10_000,
        paidCents: 4_000,
        debtCents: 6_000,
        paymentStatus: 'PARTIAL',
      },
    ],
  },
  canceled: {
    dateBasis: 'canceledAt',
    saleCount: 1,
    rows: [
      {
        id: 'sale-2',
        folio: null,
        confirmedAt: '2026-01-02T10:00:00.000Z',
        canceledAt: '2026-01-03T10:00:00.000Z',
        totalCents: 5_000,
      },
    ],
  },
};

const FULL_RESPONSE: BranchSalesSummaryResponseDto = {
  timeZone: ANALYTICS_TIME_ZONE,
  from: RANGE.from,
  to: RANGE.to,
  grossSalesCents: 1_250_000,
  netSalesCents: 1_180_000,
  collectedCents: 980_000,
  outstandingDebtCents: 200_000,
  saleCount: 42,
  averageTicketCents: 28_095,
  settledRefundsCents: 55_000,
  pendingRefundObligationsCents: 12_500,
};

const EMPTY_RESPONSE: BranchSalesSummaryResponseDto = {
  ...FULL_RESPONSE,
  grossSalesCents: 0,
  netSalesCents: 0,
  collectedCents: 0,
  outstandingDebtCents: 0,
  saleCount: 0,
  averageTicketCents: 0,
  settledRefundsCents: 0,
  pendingRefundObligationsCents: 0,
};

const TIMESERIES_POINTS: BranchSalesTimeseriesPointDto[] = [
  {
    date: '2026-01-01',
    grossSalesCents: 1_000,
    netSalesCents: 900,
    collectedCents: 800,
    outstandingDebtCents: 100,
    saleCount: 3,
    averageTicketCents: 300,
  },
  {
    date: '2026-01-02',
    grossSalesCents: 0,
    netSalesCents: 0,
    collectedCents: 0,
    outstandingDebtCents: 0,
    saleCount: 0,
    averageTicketCents: 0,
  },
];

const TIMESERIES_RESPONSE: BranchSalesTimeseriesResponseDto = {
  timeZone: ANALYTICS_TIME_ZONE,
  from: RANGE.from,
  to: RANGE.to,
  interval: 'day',
  points: TIMESERIES_POINTS,
};

describe('Analytics HTTP contract (bas-3b / OI-2 S4)', () => {
  const url = '/analytics/sales/summary';
  let app: INestApplication;
  let summarize: jest.MockedFunction<BranchSalesSummaryService['summarize']>;
  let getTimeseries: jest.MockedFunction<
    BranchSalesTimeseriesService['getTimeseries']
  >;
  let getSellerReport: jest.MockedFunction<
    SellerSalesReportService['getSellerReport']
  >;
  const http = () => request(app.getHttpServer());
  const asReader = () =>
    http().get(url).set('Authorization', 'Bearer tenant-analytics-reader');

  beforeEach(async () => {
    summarize = jest.fn();
    summarize.mockResolvedValue(FULL_RESPONSE);
    getTimeseries = jest.fn();
    getTimeseries.mockResolvedValue(TIMESERIES_RESPONSE);
    getSellerReport = jest.fn();
    getSellerReport.mockResolvedValue(SELLER_REPORT_RESPONSE);

    const moduleRef = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        { provide: BranchSalesSummaryService, useValue: { summarize } },
        { provide: BranchSalesTimeseriesService, useValue: { getTimeseries } },
        { provide: SellerSalesReportService, useValue: { getSellerReport } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard)
      .overrideGuard(TenantContextGuard)
      .useClass(TestTenantContextGuard)
      .overrideGuard(PermissionsGuard)
      .useClass(TestPermissionsGuard)
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
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 without bearer authentication', async () => {
    await http()
      .get(url)
      .query({ ...RANGE })
      .expect(401);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('returns 403 for a tenant user lacking the exact read:Analytics tuple', async () => {
    await http()
      .get(url)
      .set('Authorization', 'Bearer tenant-sale-reader')
      .query({ ...RANGE })
      .expect(403);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('returns 200, delegates once with the normalized range, and serializes the stable contract', async () => {
    const res = await asReader()
      .query({ ...RANGE })
      .expect(200);

    expect(summarize).toHaveBeenCalledTimes(1);
    const delegated: BranchSalesSummaryQueryDto = summarize.mock.calls[0][0];
    expect(delegated).toEqual({ ...RANGE });
    expect(Object.keys(delegated).sort()).toEqual(['from', 'to']);

    const body = res.body as BranchSalesSummaryResponseDto;
    expect(body).toEqual(FULL_RESPONSE);
    expect(Object.keys(body).sort()).toEqual(
      [...BRANCH_SALES_SUMMARY_RESPONSE_KEYS].sort(),
    );
    expect(BRANCH_SALES_SUMMARY_RESPONSE_KEYS).toHaveLength(11);
    expect(body).not.toHaveProperty('cashNetCents');
    expect(body).not.toHaveProperty('paymentMethod');
    expect(body).not.toHaveProperty('paymentMethodBreakdown');
  });

  it('returns the exact all-zero response for an empty aggregate', async () => {
    summarize.mockResolvedValue(EMPTY_RESPONSE);

    const res = await asReader()
      .query({ ...RANGE })
      .expect(200);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(res.body as BranchSalesSummaryResponseDto).toEqual(EMPTY_RESPONSE);
    const zeros = Object.values(EMPTY_RESPONSE).filter((value) => value === 0);
    expect(zeros).toHaveLength(8);
  });

  it.each([
    ['missing from', { to: RANGE.to }],
    ['missing to', { from: RANGE.from }],
    [
      'a timestamp instead of a local calendar date',
      { from: '2026-01-01T00:00:00.000Z', to: RANGE.to },
    ],
    ['an impossible local calendar date', { from: '2025-02-29', to: RANGE.to }],
    ['equal half-open bounds', { from: RANGE.from, to: RANGE.from }],
    ['reversed bounds', { from: RANGE.to, to: RANGE.from }],
    ['a 367-day range', { from: '2026-01-01', to: '2027-01-03' }],
  ])('returns 400 for %s', async (_case, query) => {
    await asReader().query(query).expect(400);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('returns 200 for an exact 366-day leap-boundary range', async () => {
    await asReader()
      .query({ from: '2024-01-01', to: '2025-01-01' })
      .expect(200);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown query fields with 400 (forbidNonWhitelisted)', async () => {
    await asReader()
      .query({ ...RANGE, branchId: 'branch-1' })
      .expect(400);
    expect(summarize).not.toHaveBeenCalled();
  });

  describe('GET /analytics/sales/timeseries (OI-2 S4)', () => {
    const timeseriesUrl = '/analytics/sales/timeseries';
    const asTimeseriesReader = () =>
      http()
        .get(timeseriesUrl)
        .set('Authorization', 'Bearer tenant-analytics-reader');

    it('defaults an omitted interval to day and returns the exact response surface', async () => {
      const res = await asTimeseriesReader()
        .query({ ...RANGE })
        .expect(200);

      expect(getTimeseries).toHaveBeenCalledTimes(1);
      const delegated: BranchSalesTimeseriesQueryDto =
        getTimeseries.mock.calls[0][0];
      expect(delegated).toEqual({ ...RANGE, interval: 'day' });
      expect(Object.keys(delegated).sort()).toEqual(['from', 'interval', 'to']);

      const body = res.body as BranchSalesTimeseriesResponseDto;
      expect(body).toEqual(TIMESERIES_RESPONSE);
      expect(Object.keys(body).sort()).toEqual(
        [...BRANCH_SALES_TIMESERIES_RESPONSE_KEYS].sort(),
      );
      expect(BRANCH_SALES_TIMESERIES_RESPONSE_KEYS).toHaveLength(5);
      expect(Object.keys(body.points[0]).sort()).toEqual(
        [...BRANCH_SALES_TIMESERIES_POINT_KEYS].sort(),
      );
      expect(BRANCH_SALES_TIMESERIES_POINT_KEYS).toHaveLength(7);
      expect(body).not.toHaveProperty('cashNetCents');
      expect(body).not.toHaveProperty('paymentMethod');
      expect(body).not.toHaveProperty('currency');
    });

    it('accepts an explicit day interval and forwards the DTO unchanged', async () => {
      await asTimeseriesReader()
        .query({ ...RANGE, interval: 'day' })
        .expect(200);

      expect(getTimeseries).toHaveBeenCalledTimes(1);
      expect(getTimeseries.mock.calls[0][0]).toEqual({
        ...RANGE,
        interval: 'day',
      });
    });

    it('rejects an unsupported interval with 400 through the global pipe', async () => {
      await asTimeseriesReader()
        .query({ ...RANGE, interval: 'week' })
        .expect(400);
      expect(getTimeseries).not.toHaveBeenCalled();
    });

    it.each([
      ['missing from', { to: RANGE.to }],
      ['missing to', { from: RANGE.from }],
      [
        'a timestamp instead of a local calendar date',
        { from: '2026-01-01T00:00:00.000Z', to: RANGE.to },
      ],
      [
        'an impossible local calendar date',
        { from: '2025-02-29', to: RANGE.to },
      ],
      ['reversed bounds', { from: RANGE.to, to: RANGE.from }],
      ['a 367-day range', { from: '2026-01-01', to: '2027-01-03' }],
    ])('keeps the inherited summary rule: 400 for %s', async (_case, query) => {
      await asTimeseriesReader().query(query).expect(400);
      expect(getTimeseries).not.toHaveBeenCalled();
    });

    it('rejects tenant scope supplied as query input with 400', async () => {
      await asTimeseriesReader()
        .query({ ...RANGE, tenantId: 'tenant-1' })
        .expect(400);
      expect(getTimeseries).not.toHaveBeenCalled();
    });

    it('returns 403 for a tenant user lacking read:Analytics and never delegates', async () => {
      await http()
        .get(timeseriesUrl)
        .set('Authorization', 'Bearer tenant-sale-reader')
        .query({ ...RANGE })
        .expect(403);
      expect(getTimeseries).not.toHaveBeenCalled();
    });

    it('accepts the exact 366-day leap-boundary range', async () => {
      await asTimeseriesReader()
        .query({ from: '2024-01-01', to: '2025-01-01' })
        .expect(200);
      expect(getTimeseries).toHaveBeenCalledTimes(1);
    });

    it('forwards a single local day verbatim without date arithmetic', async () => {
      await asTimeseriesReader()
        .query({ from: '2026-03-08', to: '2026-03-09' })
        .expect(200);

      expect(getTimeseries.mock.calls[0][0]).toEqual({
        from: '2026-03-08',
        to: '2026-03-09',
        interval: 'day',
      });
      expect(summarize).not.toHaveBeenCalled();
    });
  });

  describe('GET /analytics/sales/sellers/:sellerUserId/report (seller-sales-report / v1)', () => {
    const url = `/analytics/sales/sellers/${SELLER_ID}/report`;
    const asReportReader = () =>
      http()
        .get(url)
        .set('Authorization', 'Bearer tenant-analytics-sale-reader');

    it('returns 401 without bearer authentication', async () => {
      await http()
        .get(url)
        .query({ ...RANGE })
        .expect(401);
      expect(getSellerReport).not.toHaveBeenCalled();
    });

    it.each([
      ['lacking read:Sale', 'tenant-analytics-reader'],
      ['lacking read:Analytics', 'tenant-sale-reader'],
    ])(
      'returns 403 for a tenant user %s and never delegates',
      async (_case, token) => {
        await http()
          .get(url)
          .set('Authorization', `Bearer ${token}`)
          .query({ ...RANGE })
          .expect(403);
        expect(getSellerReport).not.toHaveBeenCalled();
      },
    );

    it('returns 200 with no-store and the exact frozen contract, delegating once', async () => {
      const res = await asReportReader()
        .query({ ...RANGE })
        .expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(getSellerReport).toHaveBeenCalledTimes(1);
      expect(getSellerReport).toHaveBeenCalledWith(SELLER_ID, { ...RANGE });

      const body = res.body as SellerSalesReportResponseDto;
      expect(body).toEqual(SELLER_REPORT_RESPONSE);
      expect(Object.keys(body).sort()).toEqual(
        [...SELLER_SALES_REPORT_RESPONSE_KEYS].sort(),
      );
      expect(SELLER_SALES_REPORT_RESPONSE_KEYS).toHaveLength(12);
      expect(Object.keys(body.confirmed.rows[0]).sort()).toEqual(
        [...SELLER_SALES_REPORT_CONFIRMED_ROW_KEYS].sort(),
      );
      expect(Object.keys(body.canceled.rows[0]).sort()).toEqual(
        [...SELLER_SALES_REPORT_CANCELED_ROW_KEYS].sort(),
      );
      expect(JSON.stringify(body)).not.toMatch(
        /customer|email|phone|address|currency|cashier|items|cancelReason/i,
      );
    });

    it('rejects a non-UUID seller id with 400 and never delegates', async () => {
      await http()
        .get('/analytics/sales/sellers/not-a-uuid/report')
        .set('Authorization', 'Bearer tenant-analytics-sale-reader')
        .query({ ...RANGE })
        .expect(400);
      expect(getSellerReport).not.toHaveBeenCalled();
    });

    it.each([
      ['missing from', { to: RANGE.to }],
      ['a timestamp bound', { from: '2026-01-01T00:00:00.000Z', to: RANGE.to }],
      ['reversed bounds', { from: RANGE.to, to: RANGE.from }],
      ['a 367-day range', { from: '2026-01-01', to: '2027-01-03' }],
      ['an unknown query param', { ...RANGE, tenantId: 'tenant-1' }],
    ])('returns 400 for %s', async (_case, query) => {
      await asReportReader().query(query).expect(400);
      expect(getSellerReport).not.toHaveBeenCalled();
    });

    it('returns 404 with the existing SELLER_NOT_FOUND envelope', async () => {
      getSellerReport.mockRejectedValue(new SellerNotFoundError());
      const res = await asReportReader()
        .query({ ...RANGE })
        .expect(404);
      expect(res.body).toMatchObject({
        statusCode: 404,
        error: 'SELLER_NOT_FOUND',
        message: 'SELLER_NOT_FOUND',
      });
    });

    it('returns 422 with the frozen row-limit envelope and no partial report', async () => {
      getSellerReport.mockRejectedValue(
        new SellerReportRowLimitExceededError(1001, 1000),
      );
      const res = await asReportReader()
        .query({ ...RANGE })
        .expect(422);
      expect(res.body).toMatchObject({
        statusCode: 422,
        error: 'SELLER_REPORT_ROW_LIMIT_EXCEEDED',
        message: 'SELLER_REPORT_ROW_LIMIT_EXCEEDED',
        rowLimit: 1000,
        rowCount: 1001,
      });
      expect(res.body).toHaveProperty('timestamp');
    });
  });
});
