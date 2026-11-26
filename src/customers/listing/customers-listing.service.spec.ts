import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { CustomersListingQueryDto } from './customers-listing-query.dto';
import { CustomersListingOptionField } from './customers-listing-options-query.dto';
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
  const listOptions = jest.fn<
    ReturnType<CustomersListingReader['listOptions']>,
    Parameters<CustomersListingReader['listOptions']>
  >(() => Promise.resolve([{ value: 'Del Valle', customersCount: 4 }]));
  const reader: CustomersListingReader = { findPage, summarize, listOptions };
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
  return { service, reader: { findPage, summarize, listOptions } };
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
      metrics: {
        overdueBefore: new Date('2026-11-26T00:00:00.000Z'),
        timeZone: 'America/Mexico_City',
      },
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
        metrics: {
          overdueBefore: new Date(cutoff),
          timeZone: 'America/Mexico_City',
        },
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
        metrics: {
          overdueBefore: new Date('2026-11-26T00:00:00.000Z'),
          timeZone: 'America/Mexico_City',
        },
      }),
    );
  });
});

describe('CustomersListingService — §4 filters and §5 options (T3)', () => {
  it('maps every §4.1–§4.5 param into the reader filters; empty CSVs are no filter', async () => {
    const { service, reader } = setup();
    const uuid = '3f0c8f0e-9b5a-4c47-9d0e-6f1f5a2b7c10';
    const dto = plainToInstance(CustomersListingQueryDto, {
      search: ' ana ',
      hasDebt: 'true',
      openDebtMin: '100',
      openDebtMax: '900',
      hasOverdue: 'false',
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
      createdFrom: '2025-01-01',
      createdTo: '2025-12-31',
      petSpecies: 'DOG',
      petSize: '',
      activePetsMin: '1',
      activePetsMax: '2',
      hasPets: 'true',
      neighborhood: 'Roma',
      municipality: ' , ',
      city: 'CDMX',
      zipCode: '06700',
      deliveryZoneType: 'FREE',
      deliveryZoneNone: 'true',
      priceListId: uuid,
      priceListIncludeNull: 'true',
      isTrusted: 'false',
      hasRfc: 'true',
      fiscalRegime: '612',
      hasEmail: 'false',
      hasPhone: 'true',
      hasChatbotRequests: 'true',
    });

    await service.list(dto, ability(true));

    expect(reader.findPage.mock.calls[0][0].filters).toEqual({
      search: ' ana ',
      hasDebt: true,
      openDebtMin: 100,
      openDebtMax: 900,
      hasOverdue: false,
      overdueMoreThanDays: 30,
      oldestOverdueFrom: new Date('2026-10-01'),
      oldestOverdueTo: new Date('2026-10-31'),
      totalSoldMin: 1,
      totalSoldMax: 2,
      salesCountMin: 0,
      salesCountMax: 3,
      averageTicketMin: 10,
      averageTicketMax: 20,
      lastPurchaseFrom: new Date('2026-01-01'),
      lastPurchaseTo: new Date('2026-02-01'),
      noPurchaseMoreThanDays: 90,
      createdFrom: new Date('2025-01-01'),
      createdTo: new Date('2025-12-31'),
      petSpecies: ['DOG'],
      activePetsMin: 1,
      activePetsMax: 2,
      hasPets: true,
      neighborhood: ['Roma'],
      city: ['CDMX'],
      zipCode: ['06700'],
      deliveryZoneType: ['FREE'],
      deliveryZoneNone: true,
      priceListId: [uuid],
      priceListIncludeNull: true,
      isTrusted: false,
      hasRfc: true,
      fiscalRegime: ['612'],
      hasEmail: false,
      hasPhone: true,
      hasChatbotRequests: true,
    });
    expect(reader.summarize.mock.calls[0][0].filters).toEqual(
      reader.findPage.mock.calls[0][0].filters,
    );
  });

  it('without read:Sale, every §4.1/§4.2 metric param → 400 before any query', async () => {
    const samples: Record<string, string> = {
      hasDebt: 'false',
      openDebtMax: '0',
      overdueMoreThanDays: '30',
      oldestOverdueTo: '2026-10-31',
      averageTicketMin: '10',
      lastPurchaseFrom: '2026-01-01',
      noPurchaseMoreThanDays: '90',
    };
    for (const [key, value] of Object.entries(samples)) {
      const { service, reader } = setup();
      const error = await service
        .list(query({ [key]: value }), ability(false))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'LISTING_PARAM_REQUIRES_PERMISSION',
        field: key,
      });
      expect(reader.findPage).not.toHaveBeenCalled();
    }
  });

  it('without read:Sale, customer-level filters reach the reader', async () => {
    const { service, reader } = setup();
    await service.list(
      query({ hasPets: 'true', city: 'CDMX', isTrusted: 'true' }),
      ability(false),
    );
    expect(reader.findPage).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: null,
        filters: { hasPets: true, city: ['CDMX'], isTrusted: true },
      }),
    );
  });

  it('options: trims q (blank → none) and returns {field, data}', async () => {
    const { service, reader } = setup();
    const res = await service.options({
      field: CustomersListingOptionField.neighborhood,
      q: '  del  ',
      limit: 10,
    });
    expect(reader.listOptions).toHaveBeenCalledWith({
      field: 'neighborhood',
      q: 'del',
      limit: 10,
    });
    expect(res).toEqual({
      field: 'neighborhood',
      data: [{ value: 'Del Valle', customersCount: 4 }],
    });

    await service.options({
      field: CustomersListingOptionField.fiscalRegime,
      q: '   ',
      limit: 50,
    });
    expect(reader.listOptions).toHaveBeenLastCalledWith({
      field: 'fiscalRegime',
      q: undefined,
      limit: 50,
    });
  });
});
