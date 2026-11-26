import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomersListingQueryDto } from './customers-listing-query.dto';
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

// ─────── T3: the §4.1/§4.2 params through the real DTO (what the service sees) ───────

describe('§10.1 with the parsed CustomersListingQueryDto (T3)', () => {
  const METRIC_SAMPLES: Record<(typeof METRIC_FILTER_PARAMS)[number], string> =
    {
      hasDebt: 'false',
      openDebtMin: '0',
      openDebtMax: '100',
      hasOverdue: 'true',
      overdueMoreThanDays: '30',
      oldestOverdueFrom: '2026-10-01',
      oldestOverdueTo: '2026-10-31',
      totalSoldMin: '1',
      totalSoldMax: '2',
      salesCountMin: '0',
      salesCountMax: '3',
      averageTicketMin: '10',
      averageTicketMax: '20',
      lastPurchaseFrom: '2026-01-01',
      lastPurchaseTo: '2026-02-01',
      noPurchaseMoreThanDays: '90',
    };

  async function parsed(query: Record<string, string>) {
    const dto = plainToInstance(CustomersListingQueryDto, query);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toEqual([]);
    return dto as unknown as Record<string, unknown>;
  }

  it('the defaults of an empty query are not metric params', async () => {
    const dto = await parsed({});
    expect(() => assertListingParamsPermitted(dto, false)).not.toThrow();
  });

  it.each(Object.entries(METRIC_SAMPLES))(
    'without read:Sale, %s=%s → 400 on that field',
    async (key, value) => {
      const dto = await parsed({ [key]: value });
      const error = caught(() => assertListingParamsPermitted(dto, false));
      expect(error.getResponse()).toEqual({
        statusCode: 400,
        code: 'LISTING_PARAM_REQUIRES_PERMISSION',
        message: `${key} requires read:Sale`,
        field: key,
        details: { required: 'read:Sale' },
      });
    },
  );

  it('every metric param at once → the first in §10.1 order (hasDebt)', async () => {
    const dto = await parsed({ ...METRIC_SAMPLES, sortBy: 'openDebt' });
    const error = caught(() => assertListingParamsPermitted(dto, false));
    expect((error.getResponse() as { field: string }).field).toBe('hasDebt');
  });

  it('the customer-level §4.2–§4.5 params pass without read:Sale', async () => {
    const dto = await parsed({
      createdFrom: '2026-01-01',
      createdTo: '2026-02-01',
      petSpecies: 'DOG',
      petSize: 'LARGE',
      activePetsMin: '1',
      activePetsMax: '2',
      hasPets: 'true',
      neighborhood: 'Roma',
      municipality: 'Cuauhtémoc',
      city: 'CDMX',
      zipCode: '06700',
      deliveryZoneType: 'FREE',
      deliveryZoneNone: 'true',
      priceListId: '3f0c8f0e-9b5a-4c47-9d0e-6f1f5a2b7c10',
      priceListIncludeNull: 'true',
      isTrusted: 'true',
      hasRfc: 'false',
      fiscalRegime: '612',
      hasEmail: 'false',
      hasPhone: 'false',
      hasChatbotRequests: 'true',
      sortBy: 'name',
    });
    expect(() => assertListingParamsPermitted(dto, false)).not.toThrow();
  });
});
