import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { CustomersListingQueryDto } from './customers-listing-query.dto';
import { CustomersListingService } from './customers-listing.service';
import type {
  CustomerListingRow,
  CustomersListingReader,
} from './customer-listing.types';

const row = (id: string, withMetrics: boolean): CustomerListingRow => ({
  id,
  firstName: 'Ana',
  lastName: null,
  businessName: null,
  phoneCountryCode: null,
  phone: null,
  email: null,
  globalPriceList: null,
  rfc: null,
  fiscalRegime: null,
  preferredPaymentMethod: null,
  isTrusted: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  primaryAddress: null,
  activePetsCount: 0,
  petSpecies: [],
  matchedPetName: null,
  ...(withMetrics
    ? {
        metrics: {
          openDebtCents: 0,
          overdueDebtCents: 0,
          overdueCount: 0,
          oldestOverdueDueDate: null,
          salesCount: 0,
          totalSoldCents: 0,
          averageTicketCents: null,
          lastPurchaseAt: null,
        },
      }
    : {}),
});

function setup(
  opts: {
    now?: string;
    timeZone?: string | undefined;
    total?: number;
  } = {},
) {
  const findPage = jest.fn<
    ReturnType<CustomersListingReader['findPage']>,
    Parameters<CustomersListingReader['findPage']>
  >(({ metrics }) => Promise.resolve([row('c1', metrics !== null)]));
  const summarize = jest.fn<
    ReturnType<CustomersListingReader['summarize']>,
    Parameters<CustomersListingReader['summarize']>
  >(({ metrics }) =>
    Promise.resolve(
      metrics
        ? {
            count: opts.total ?? 101,
            openDebtCents: 7000,
            overdueDebtCents: 3000,
          }
        : { count: opts.total ?? 101 },
    ),
  );
  const reader: CustomersListingReader = { findPage, summarize };
  const config = {
    get: jest.fn((key: string) =>
      key === 'PROMOTIONS_BUSINESS_TIMEZONE'
        ? 'timeZone' in opts
          ? opts.timeZone
          : 'America/Mexico_City'
        : undefined,
    ),
  } as unknown as ConfigService;
  const now = new Date(opts.now ?? '2026-11-26T18:00:00.000Z');
  const service = new CustomersListingService(reader, config, () => now);
  return { service, reader: { findPage, summarize } };
}

const ability = (canReadSale: boolean) => ({
  can: jest.fn(
    (action: string, subject: string) =>
      action === 'read' && (subject === 'Customer' || canReadSale),
  ),
});

const query = (q: Record<string, unknown> = {}) =>
  plainToInstance(CustomersListingQueryDto, q);

describe('CustomersListingService (contract §3, §10.1)', () => {
  it('with read:Sale: metrics requested with the GET /sales cut-off, full filterSummary, pagination like GET /sales', async () => {
    const { service, reader } = setup({ total: 101 });

    const res = await service.list(
      query({ page: '2', limit: '50', search: 'ana' }),
      ability(true),
    );

    const expectedInput = {
      filters: { search: 'ana' },
      sortBy: 'createdAt',
      sortOrder: 'desc',
      page: 2,
      limit: 50,
      metrics: { overdueBefore: new Date('2026-11-26T00:00:00.000Z') },
    };
    expect(reader.findPage).toHaveBeenCalledWith(expectedInput);
    expect(reader.summarize).toHaveBeenCalledWith(expectedInput);
    expect(res.pagination).toEqual({
      page: 2,
      limit: 50,
      total: 101,
      totalPages: 3,
    });
    expect(res.filterSummary).toEqual({
      count: 101,
      openDebtCents: 7000,
      overdueDebtCents: 3000,
    });
    expect(res.data[0]).toHaveProperty('metrics');
  });

  it('without read:Sale: 200 shape, no metrics requested, filterSummary {count}', async () => {
    const { service, reader } = setup({ total: 3 });

    const res = await service.list(
      query({ sortBy: 'name', sortOrder: 'asc' }),
      ability(false),
    );

    expect(reader.findPage).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: null, sortBy: 'name' }),
    );
    expect(res.filterSummary).toEqual({ count: 3 });
    expect(Object.keys(res.filterSummary)).toEqual(['count']);
    expect(res.data[0]).not.toHaveProperty('metrics');
  });

  it('without read:Sale, a metric sort is rejected before any query', async () => {
    const { service, reader } = setup();
    await expect(
      service.list(query({ sortBy: 'openDebt' }), ability(false)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(reader.findPage).not.toHaveBeenCalled();
    expect(reader.summarize).not.toHaveBeenCalled();
  });

  it('total 0 → totalPages 0', async () => {
    const { service } = setup({ total: 0 });
    const res = await service.list(query(), ability(true));
    expect(res.pagination).toEqual({
      page: 1,
      limit: 50,
      total: 0,
      totalPages: 0,
    });
  });

  it.each([
    // 23:59 local on 26/11 (UTC-6) → local today 26/11.
    ['2026-11-27T05:59:00.000Z', '2026-11-26T00:00:00.000Z'],
    // 00:00 local on 27/11 → local today 27/11.
    ['2026-11-27T06:00:00.000Z', '2026-11-27T00:00:00.000Z'],
  ])('cut-off at %s is 00:00Z of the local today (%s)', async (now, cutoff) => {
    const { service, reader } = setup({ now });
    await service.list(query(), ability(true));
    expect(reader.findPage).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: { overdueBefore: new Date(cutoff) },
      }),
    );
  });

  it('falls back to America/Mexico_City when the timezone is not configured', async () => {
    const { service, reader } = setup({
      now: '2026-11-27T05:59:00.000Z',
      timeZone: undefined,
    });
    await service.list(query(), ability(true));
    expect(reader.findPage).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: { overdueBefore: new Date('2026-11-26T00:00:00.000Z') },
      }),
    );
  });
});
