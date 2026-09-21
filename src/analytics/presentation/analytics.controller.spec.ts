/**
 * bas-3a controller tests: thin delegation + reflected route/guard metadata.
 * The HTTP transport contract is owned by bas-3b.
 */
import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import { BranchSalesSummaryService } from '../application/branch-sales-summary.service';
import type { BranchSalesSummaryQueryDto } from '../dto/branch-sales-summary-query.dto';
import type { BranchSalesSummaryResponseDto } from '../dto/branch-sales-summary-response.dto';
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
  let controller: AnalyticsController;

  beforeEach(() => {
    summarize = jest.fn(() => Promise.resolve(response));
    controller = new AnalyticsController({
      summarize,
    } as unknown as BranchSalesSummaryService);
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
});
