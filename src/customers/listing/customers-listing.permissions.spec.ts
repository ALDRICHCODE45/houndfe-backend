import { BadRequestException } from '@nestjs/common';
import {
  METRIC_FILTER_PARAMS,
  METRIC_SORT_KEYS,
  assertListingParamsPermitted,
} from './customers-listing.permissions';

function caught(fn: () => void): BadRequestException {
  try {
    fn();
  } catch (error) {
    if (error instanceof BadRequestException) return error;
    throw error;
  }
  throw new Error('expected a BadRequestException');
}

describe('assertListingParamsPermitted (contract §10.1)', () => {
  it('lists the metric filters in the §10.1 order and the metric sorts', () => {
    expect(METRIC_FILTER_PARAMS).toEqual([
      'hasDebt',
      'openDebtMin',
      'openDebtMax',
      'hasOverdue',
      'overdueMoreThanDays',
      'oldestOverdueFrom',
      'oldestOverdueTo',
      'totalSoldMin',
      'totalSoldMax',
      'salesCountMin',
      'salesCountMax',
      'averageTicketMin',
      'averageTicketMax',
      'lastPurchaseFrom',
      'lastPurchaseTo',
      'noPurchaseMoreThanDays',
    ]);
    expect([...METRIC_SORT_KEYS].sort()).toEqual(
      [
        'averageTicket',
        'lastPurchaseAt',
        'oldestOverdue',
        'openDebt',
        'salesCount',
        'totalSold',
      ].sort(),
    );
  });

  it.each([...METRIC_SORT_KEYS])(
    'without read:Sale, sortBy=%s → 400 LISTING_PARAM_REQUIRES_PERMISSION on sortBy',
    (sortBy) => {
      const error = caught(() =>
        assertListingParamsPermitted({ sortBy }, false),
      );
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toEqual({
        statusCode: 400,
        code: 'LISTING_PARAM_REQUIRES_PERMISSION',
        message: 'sortBy requires read:Sale',
        field: 'sortBy',
        details: { required: 'read:Sale' },
      });
    },
  );

  it('reports the FIRST metric filter in §10.1 order, before sortBy', () => {
    const error = caught(() =>
      assertListingParamsPermitted(
        {
          sortBy: 'openDebt',
          salesCountMin: 2,
          openDebtMin: 100,
          hasOverdue: true,
        },
        false,
      ),
    );
    expect(error.getResponse()).toEqual({
      statusCode: 400,
      code: 'LISTING_PARAM_REQUIRES_PERMISSION',
      message: 'openDebtMin requires read:Sale',
      field: 'openDebtMin',
      details: { required: 'read:Sale' },
    });
  });

  it('a metric filter set to false is still a metric param', () => {
    const error = caught(() =>
      assertListingParamsPermitted({ hasDebt: false }, false),
    );
    expect((error.getResponse() as { field: string }).field).toBe('hasDebt');
  });

  it.each(['name', 'createdAt', undefined])(
    'without read:Sale, sortBy=%s and non-metric params pass',
    (sortBy) => {
      expect(() =>
        assertListingParamsPermitted(
          { sortBy, search: 'ana', page: 2, limit: 10, sortOrder: 'asc' },
          false,
        ),
      ).not.toThrow();
    },
  );

  it('with read:Sale every metric param passes', () => {
    const all: Record<string, unknown> = { sortBy: 'averageTicket' };
    for (const key of METRIC_FILTER_PARAMS) all[key] = 1;
    expect(() => assertListingParamsPermitted(all, true)).not.toThrow();
  });
});
