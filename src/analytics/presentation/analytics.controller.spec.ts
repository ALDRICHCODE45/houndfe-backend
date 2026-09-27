/**
 * bas-3a / OI-2 S4 controller tests: thin delegation, reflected route/guard
 * metadata, and AnalyticsModule wiring. The HTTP transport contract is owned
 * by bas-3b / S4.
 */
import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PARAMTYPES_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import { BranchSalesSummaryService } from '../application/branch-sales-summary.service';
import { BranchSalesTimeseriesService } from '../application/branch-sales-timeseries.service';
import { SellerSalesReportService } from '../application/seller-sales-report.service';
import { BRANCH_SALES_SUMMARY_REPOSITORY } from '../domain/branch-sales-summary.repository';
import { BRANCH_SALES_TIMESERIES_REPOSITORY } from '../domain/branch-sales-timeseries.repository';
import { SELLER_SALES_REPORT_REPOSITORY } from '../domain/seller-sales-report.repository';
import { PrismaBranchSalesSummaryRepository } from '../infrastructure/prisma-branch-sales-summary.repository';
import { PrismaBranchSalesTimeseriesRepository } from '../infrastructure/prisma-branch-sales-timeseries.repository';
import { PrismaSellerSalesReportRepository } from '../infrastructure/prisma-seller-sales-report.repository';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { AuthModule } from '../../auth/auth.module';
import { BranchSalesSummaryQueryDto } from '../dto/branch-sales-summary-query.dto';
import type { BranchSalesSummaryResponseDto } from '../dto/branch-sales-summary-response.dto';
import { BranchSalesTimeseriesQueryDto } from '../dto/branch-sales-timeseries-query.dto';
import type { BranchSalesTimeseriesResponseDto } from '../dto/branch-sales-timeseries-response.dto';
import type { SellerSalesReportResponseDto } from '../dto/seller-sales-report-response.dto';
import { AnalyticsModule } from '../analytics.module';
import { AnalyticsController } from './analytics.controller';

const query: BranchSalesSummaryQueryDto = {
  from: '2026-01-01',
  to: '2026-02-01',
};
const response: BranchSalesSummaryResponseDto = {
  timeZone: 'America/Mexico_City',
  from: query.from,
  to: query.to,
  grossSalesCents: 100_000,
  netSalesCents: 95_000,
  collectedCents: 80_000,
  outstandingDebtCents: 15_000,
  saleCount: 12,
  averageTicketCents: 7_917,
  settledRefundsCents: 4_000,
  pendingRefundObligationsCents: 2_500,
};
const timeseriesQuery: BranchSalesTimeseriesQueryDto = {
  from: '2026-01-01',
  to: '2026-01-02',
  interval: 'day',
};
const timeseriesResponse: BranchSalesTimeseriesResponseDto = {
  timeZone: 'America/Mexico_City',
  from: timeseriesQuery.from,
  to: timeseriesQuery.to,
  interval: 'day',
  points: [
    {
      date: '2026-01-01',
      grossSalesCents: 1_000,
      netSalesCents: 900,
      collectedCents: 800,
      outstandingDebtCents: 100,
      saleCount: 3,
      averageTicketCents: 300,
    },
  ],
};
const SELLER_ID = '11111111-1111-4111-8111-111111111111';
const sellerReportResponse: SellerSalesReportResponseDto = {
  seller: { id: SELLER_ID, name: 'Vendedor Uno' },
  tenantId: 'tenant-1',
  timeZone: 'America/Mexico_City',
  from: '2026-01-01',
  to: '2026-02-01',
  generatedAt: '2026-03-01T12:00:00.000Z',
  attribution: 'CURRENT_SELLER',
  balances: 'CURRENT',
  rowLimit: 1000,
  rowCount: 1,
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
    saleCount: 0,
    rows: [],
  },
};
/** Reads the handler function for a route method (metadata lives there). */
const handlerOf = (method: string): object => {
  const handler = Object.getOwnPropertyDescriptor(
    AnalyticsController.prototype,
    method,
  )?.value as object | undefined;
  expect(handler).toBeDefined();
  return handler as object;
};

describe('AnalyticsController', () => {
  let summarize: jest.Mock;
  let getTimeseries: jest.Mock;
  let getSellerReport: jest.Mock;
  let controller: AnalyticsController;

  beforeEach(() => {
    summarize = jest.fn(() => Promise.resolve(response));
    getTimeseries = jest.fn(() => Promise.resolve(timeseriesResponse));
    getSellerReport = jest.fn(() => Promise.resolve(sellerReportResponse));
    controller = new AnalyticsController(
      { summarize } as unknown as BranchSalesSummaryService,
      { getTimeseries } as unknown as BranchSalesTimeseriesService,
      { getSellerReport } as unknown as SellerSalesReportService,
    );
  });

  it('delegates once with the exact query and returns the same result identity', async () => {
    const result = await controller.getSalesSummary(query);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith(query);
    expect(result).toBe(response);
  });

  it('declares the exact class-level guard order', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AnalyticsController) as
      | unknown[]
      | undefined;
    expect(guards).toEqual([
      JwtAuthGuard,
      TenantContextGuard,
      PermissionsGuard,
    ]);
  });

  it('maps GET /analytics/sales/summary with explicit HTTP 200', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AnalyticsController)).toBe(
      'analytics',
    );
    const handler = handlerOf('getSalesSummary');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('sales/summary');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
      HttpStatus.OK,
    );
  });

  it('requires exactly the (read, Analytics) permission tuple', () => {
    const handler = handlerOf('getSalesSummary');
    const permissions = Reflect.getMetadata(PERMISSIONS_KEY, handler) as
      | Array<[string, string]>
      | undefined;
    expect(permissions).toEqual([['read', 'Analytics']]);
  });

  it('delegates the timeseries query once and returns the same result identity', async () => {
    const result = await controller.getSalesTimeseries(timeseriesQuery);
    expect(getTimeseries).toHaveBeenCalledTimes(1);
    expect(getTimeseries).toHaveBeenCalledWith(timeseriesQuery);
    expect(result).toBe(timeseriesResponse);
  });

  it('maps GET /analytics/sales/timeseries with explicit HTTP 200', () => {
    const handler = handlerOf('getSalesTimeseries');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'sales/timeseries',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
      HttpStatus.OK,
    );
  });

  it('requires exactly the (read, Analytics) tuple on the timeseries route', () => {
    const permissions = Reflect.getMetadata(
      PERMISSIONS_KEY,
      handlerOf('getSalesTimeseries'),
    ) as Array<[string, string]> | undefined;
    expect(permissions).toEqual([['read', 'Analytics']]);
  });

  it('validates the timeseries query with BranchSalesTimeseriesQueryDto', () => {
    // Method parameter types live on the prototype under the method name.
    expect(
      Reflect.getMetadata(
        PARAMTYPES_METADATA,
        AnalyticsController.prototype,
        'getSalesTimeseries',
      ) as unknown,
    ).toEqual([BranchSalesTimeseriesQueryDto]);
    expect(
      Reflect.getMetadata(
        PARAMTYPES_METADATA,
        AnalyticsController.prototype,
        'getSalesSummary',
      ) as unknown,
    ).toEqual([BranchSalesSummaryQueryDto]);
  });
  it('delegates the seller report once with the exact id and query', async () => {
    const result = await controller.getSellerSalesReport(SELLER_ID, query);
    expect(getSellerReport).toHaveBeenCalledTimes(1);
    expect(getSellerReport).toHaveBeenCalledWith(SELLER_ID, query);
    expect(result).toBe(sellerReportResponse);
  });

  it('maps GET /analytics/sales/sellers/:sellerUserId/report with 200 and no-store', () => {
    const handler = handlerOf('getSellerSalesReport');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'sales/sellers/:sellerUserId/report',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
      HttpStatus.OK,
    );
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([
      { name: 'Cache-Control', value: 'no-store' },
    ]);
  });

  it('requires the read:Analytics AND read:Sale permission conjunction', () => {
    const permissions = Reflect.getMetadata(
      PERMISSIONS_KEY,
      handlerOf('getSellerSalesReport'),
    ) as Array<[string, string]> | undefined;
    expect(permissions).toEqual([
      ['read', 'Analytics'],
      ['read', 'Sale'],
    ]);
  });

  it('validates the report path UUID and reuses the summary query DTO', () => {
    expect(
      Reflect.getMetadata(
        PARAMTYPES_METADATA,
        AnalyticsController.prototype,
        'getSellerSalesReport',
      ) as unknown,
    ).toEqual([String, BranchSalesSummaryQueryDto]);
  });
});

describe('AnalyticsModule wiring (OI-2 S4)', () => {
  const providers = (): unknown[] =>
    (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AnalyticsModule) ??
      []) as unknown[];
  const bindingFor = (token: unknown) =>
    (providers() as Array<{ provide?: unknown; useClass?: unknown }>).find(
      (entry) => entry.provide === token,
    );

  it('registers both analytics services and the controller', () => {
    expect(providers()).toContain(BranchSalesTimeseriesService);
    expect(providers()).toContain(BranchSalesSummaryService);
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AnalyticsModule) as
        | unknown[]
        | undefined,
    ).toContain(AnalyticsController);
  });

  it('binds both repository tokens to their Prisma adapters', () => {
    expect(bindingFor(BRANCH_SALES_TIMESERIES_REPOSITORY)?.useClass).toBe(
      PrismaBranchSalesTimeseriesRepository,
    );
    expect(bindingFor(BRANCH_SALES_SUMMARY_REPOSITORY)?.useClass).toBe(
      PrismaBranchSalesSummaryRepository,
    );
  });

  it('imports DatabaseModule and AuthModule and exports nothing', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AnalyticsModule,
    ) as unknown[];
    expect(imports).toContain(DatabaseModule);
    expect(imports).toContain(AuthModule);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, AnalyticsModule) as unknown,
    ).toBeUndefined();
  });

  it('registers the seller report service and its repository binding', () => {
    expect(providers()).toContain(SellerSalesReportService);
    expect(bindingFor(SELLER_SALES_REPORT_REPOSITORY)?.useClass).toBe(
      PrismaSellerSalesReportRepository,
    );
  });
});
