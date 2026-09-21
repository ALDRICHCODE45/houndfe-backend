/**
 * bas-3b — HTTP contract for GET /analytics/sales/summary.
 *
 * In-memory Nest app + Supertest: the three guards become typed doubles (bearer
 * auth, tenant context, exact `read:Analytics` metadata), the service is mocked
 * with fixtures, and the global ValidationPipe mirrors `main.ts`. No DB.
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
import {
  ANALYTICS_TIME_ZONE,
  type BranchSalesSummaryQueryDto,
} from '../dto/branch-sales-summary-query.dto';
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

describe('GET /analytics/sales/summary HTTP contract (bas-3b)', () => {
  const url = '/analytics/sales/summary';
  let app: INestApplication;
  let summarize: jest.MockedFunction<BranchSalesSummaryService['summarize']>;
  const http = () => request(app.getHttpServer());
  const asReader = () =>
    http().get(url).set('Authorization', 'Bearer tenant-analytics-reader');

  beforeEach(async () => {
    summarize = jest.fn();
    summarize.mockResolvedValue(FULL_RESPONSE);

    const moduleRef = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        { provide: BranchSalesSummaryService, useValue: { summarize } },
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
});
