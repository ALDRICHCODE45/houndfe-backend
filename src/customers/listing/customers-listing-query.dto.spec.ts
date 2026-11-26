import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CustomersListingQueryDto,
  CustomersListingSortBy,
} from './customers-listing-query.dto';
import { METRIC_FILTER_PARAMS } from './customers-listing.permissions';
import { createListingValidationExceptionFactory } from '../../shared/listing';

/** Same options as the global pipe (`createAppValidationPipe`). */
async function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(CustomersListingQueryDto, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

describe('CustomersListingQueryDto (contract §3.2, §3.3, §11)', () => {
  it('defaults: page 1, limit 50, sortBy createdAt, sortOrder desc, no search', async () => {
    const { dto, errors } = await parse({});
    expect(errors).toEqual([]);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(50);
    expect(dto.sortBy).toBe('createdAt');
    expect(dto.sortOrder).toBe('desc');
    expect(dto.search).toBeUndefined();
  });

  it('coerces page/limit from query strings', async () => {
    const { dto, errors } = await parse({ page: '3', limit: '100' });
    expect(errors).toEqual([]);
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(100);
  });

  it.each([
    [{ page: '0' }, 'page'],
    [{ page: '1.5' }, 'page'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ sortBy: 'debt' }, 'sortBy'],
    [{ sortOrder: 'up' }, 'sortOrder'],
    [{ preferredPaymentMethod: 'cash' }, 'preferredPaymentMethod'],
    [{ search: ['a', 'b'] }, 'search'],
  ])('%j → validation error on %s', async (query, property) => {
    const { errors } = await parse(query);
    expect(errors.map((e) => e.property)).toEqual([property]);
  });

  it('accepts every sortBy of §3.3', async () => {
    expect(Object.values(CustomersListingSortBy).sort()).toEqual(
      [
        'averageTicket',
        'createdAt',
        'lastPurchaseAt',
        'name',
        'oldestOverdue',
        'openDebt',
        'salesCount',
        'totalSold',
      ].sort(),
    );
    for (const sortBy of Object.values(CustomersListingSortBy)) {
      for (const sortOrder of ['asc', 'desc']) {
        const { errors } = await parse({ sortBy, sortOrder });
        expect(errors).toEqual([]);
      }
    }
  });
});

// ───────────────────────── T3 / S2: §4.1–§4.5 filters ─────────────────────────

/** The listing envelope the global pipe would answer for `errors`. */
function envelope(errors: Awaited<ReturnType<typeof parse>>['errors']) {
  return createListingValidationExceptionFactory()(
    errors,
  ).getResponse() as Record<string, unknown>;
}

const FILTER_PARAMS = [
  // §4.1 / §4.2 metric params (§10.1 order)
  ...METRIC_FILTER_PARAMS,
  // §4.2 customer-level
  'createdFrom',
  'createdTo',
  // §4.3
  'petSpecies',
  'petSize',
  'activePetsMin',
  'activePetsMax',
  'hasPets',
  // §4.4
  'neighborhood',
  'municipality',
  'city',
  'zipCode',
  'deliveryZoneType',
  'deliveryZoneNone',
  // §4.5
  'priceListId',
  'priceListIncludeNull',
  'isTrusted',
  'hasRfc',
  'fiscalRegime',
  'hasEmail',
  'hasPhone',
  'hasChatbotRequests',
] as const;

describe('CustomersListingQueryDto — §4.1–§4.5 filters (T3)', () => {
  it('every filter is undefined when absent (metric params have no default: §10.1 treats defined as sent)', async () => {
    const { dto, errors } = await parse({});
    expect(errors).toEqual([]);
    for (const key of FILTER_PARAMS) {
      expect([key, (dto as unknown as Record<string, unknown>)[key]]).toEqual([
        key,
        undefined,
      ]);
    }
  });

  it('parses every param of §4.1–§4.5', async () => {
    const uuid = '3f0c8f0e-9b5a-4c47-9d0e-6f1f5a2b7c10';
    const { dto, errors } = await parse({
      hasDebt: 'true',
      openDebtMin: '100',
      openDebtMax: '5000',
      hasOverdue: 'false',
      overdueMoreThanDays: '30',
      oldestOverdueFrom: '2026-10-01',
      oldestOverdueTo: '2026-10-31T23:59:59.999Z',
      totalSoldMin: '0',
      totalSoldMax: '1000000',
      salesCountMin: '1',
      salesCountMax: '10',
      averageTicketMin: '500',
      averageTicketMax: '900',
      lastPurchaseFrom: '2026-01-01T00:00:00.000Z',
      lastPurchaseTo: '2026-11-26T00:00:00.000Z',
      noPurchaseMoreThanDays: '3650',
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-02-01T00:00:00.000Z',
      petSpecies: 'DOG, CAT,DOG',
      petSize: 'LARGE,GIANT',
      activePetsMin: '1',
      activePetsMax: '3',
      hasPets: 'true',
      neighborhood: 'Del Valle, Roma ',
      municipality: 'Benito Juárez',
      city: 'Ciudad de México',
      zipCode: '03100,06700',
      deliveryZoneType: 'FREE,DENIED',
      deliveryZoneNone: 'true',
      priceListId: uuid,
      priceListIncludeNull: 'true',
      isTrusted: 'false',
      hasRfc: 'true',
      fiscalRegime: '601,612',
      hasEmail: 'false',
      hasPhone: 'true',
      hasChatbotRequests: 'true',
    });
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({
      hasDebt: true,
      openDebtMin: 100,
      openDebtMax: 5000,
      hasOverdue: false,
      overdueMoreThanDays: 30,
      oldestOverdueFrom: new Date('2026-10-01'),
      oldestOverdueTo: new Date('2026-10-31T23:59:59.999Z'),
      totalSoldMin: 0,
      totalSoldMax: 1000000,
      salesCountMin: 1,
      salesCountMax: 10,
      averageTicketMin: 500,
      averageTicketMax: 900,
      lastPurchaseFrom: new Date('2026-01-01T00:00:00.000Z'),
      lastPurchaseTo: new Date('2026-11-26T00:00:00.000Z'),
      noPurchaseMoreThanDays: 3650,
      createdFrom: new Date('2026-01-01T00:00:00.000Z'),
      createdTo: new Date('2026-02-01T00:00:00.000Z'),
      petSpecies: ['DOG', 'CAT'],
      petSize: ['LARGE', 'GIANT'],
      activePetsMin: 1,
      activePetsMax: 3,
      hasPets: true,
      neighborhood: ['Del Valle', 'Roma'],
      municipality: ['Benito Juárez'],
      city: ['Ciudad de México'],
      zipCode: ['03100', '06700'],
      deliveryZoneType: ['FREE', 'DENIED'],
      deliveryZoneNone: true,
      priceListId: [uuid],
      priceListIncludeNull: true,
      isTrusted: false,
      hasRfc: true,
      fiscalRegime: ['601', '612'],
      hasEmail: false,
      hasPhone: true,
      hasChatbotRequests: true,
    });
  });

  // §11: standard per-field validation body.
  it.each([
    [{ hasDebt: 'yes' }, 'hasDebt'],
    [{ isTrusted: 'TRUE' }, 'isTrusted'],
    [{ hasChatbotRequests: '1' }, 'hasChatbotRequests'],
    [{ deliveryZoneNone: 'si' }, 'deliveryZoneNone'],
    [{ overdueMoreThanDays: '0' }, 'overdueMoreThanDays'],
    [{ overdueMoreThanDays: '3651' }, 'overdueMoreThanDays'],
    [{ overdueMoreThanDays: '1.5' }, 'overdueMoreThanDays'],
    [{ noPurchaseMoreThanDays: 'abc' }, 'noPurchaseMoreThanDays'],
    [{ noPurchaseMoreThanDays: '0' }, 'noPurchaseMoreThanDays'],
  ])('%j → standard validation error on %s', async (query, property) => {
    const { errors } = await parse(query);
    expect(errors.map((e) => e.property)).toEqual([property]);
    expect(
      createListingValidationExceptionFactory()(errors).getResponse(),
    ).not.toHaveProperty('code');
  });

  // §11: listing envelope codes.
  it.each([
    [{ openDebtMin: 'abc' }, 'LISTING_INVALID_NUMBER', 'openDebtMin'],
    [{ openDebtMax: '-1' }, 'LISTING_INVALID_NUMBER', 'openDebtMax'],
    [{ totalSoldMin: '10.5' }, 'LISTING_INVALID_NUMBER', 'totalSoldMin'],
    [{ salesCountMax: '-3' }, 'LISTING_INVALID_NUMBER', 'salesCountMax'],
    [
      { averageTicketMin: '1e400' },
      'LISTING_INVALID_NUMBER',
      'averageTicketMin',
    ],
    [{ activePetsMin: '0.5' }, 'LISTING_INVALID_NUMBER', 'activePetsMin'],
    [
      { openDebtMin: '500', openDebtMax: '100' },
      'LISTING_INVERTED_RANGE',
      'openDebt',
    ],
    [
      { salesCountMin: '5', salesCountMax: '2' },
      'LISTING_INVERTED_RANGE',
      'salesCount',
    ],
    [
      { activePetsMin: '3', activePetsMax: '1' },
      'LISTING_INVERTED_RANGE',
      'activePets',
    ],
    [{ createdFrom: 'ayer' }, 'LISTING_INVALID_DATE', 'createdFrom'],
    [
      { lastPurchaseTo: '2026-13-45' },
      'LISTING_INVALID_DATE',
      'lastPurchaseTo',
    ],
    [
      { oldestOverdueFrom: '2026-11-01', oldestOverdueTo: '2026-10-01' },
      'LISTING_INVERTED_RANGE',
      'oldestOverdue',
    ],
    [
      { lastPurchaseFrom: '2026-11-01', lastPurchaseTo: '2026-10-01' },
      'LISTING_INVERTED_RANGE',
      'lastPurchase',
    ],
    [
      { createdFrom: '2026-11-01', createdTo: '2026-10-01' },
      'LISTING_INVERTED_RANGE',
      'created',
    ],
    [{ petSpecies: 'DOG,FISH' }, 'LISTING_INVALID_ENUM_VALUE', 'petSpecies'],
    [{ petSize: 'TINY' }, 'LISTING_INVALID_ENUM_VALUE', 'petSize'],
    [{ fiscalRegime: '999' }, 'LISTING_INVALID_ENUM_VALUE', 'fiscalRegime'],
    [
      { deliveryZoneType: 'FREE,NAMED' },
      'LISTING_INVALID_ENUM_VALUE',
      'deliveryZoneType',
    ],
    [{ priceListId: 'not-a-uuid' }, 'LISTING_INVALID_UUID', 'priceListId'],
    [
      {
        neighborhood: Array.from({ length: 201 }, (_, i) => `c${i}`).join(','),
      },
      'LISTING_TOO_MANY_VALUES',
      'neighborhood',
    ],
    [
      { zipCode: Array.from({ length: 201 }, (_, i) => `${i}`).join(',') },
      'LISTING_TOO_MANY_VALUES',
      'zipCode',
    ],
  ])('%j → %s on %s', async (query, code, field) => {
    const { errors } = await parse(query);
    expect(errors).not.toEqual([]);
    expect(envelope(errors)).toMatchObject({ statusCode: 400, code, field });
  });

  it('zero is a valid bound; an empty CSV is no filter', async () => {
    const { dto, errors } = await parse({
      openDebtMax: '0',
      totalSoldMin: '0',
      activePetsMax: '0',
      petSpecies: '',
      neighborhood: ' , ',
    });
    expect(errors).toEqual([]);
    expect(dto.openDebtMax).toBe(0);
    expect(dto.petSpecies).toEqual([]);
    expect(dto.neighborhood).toEqual([]);
  });

  it('preferredPaymentMethod is NOT a filter (unknown parameter)', async () => {
    const { errors } = await parse({ preferredPaymentMethod: 'efectivo' });
    expect(errors.map((e) => e.property)).toEqual(['preferredPaymentMethod']);
  });
});
