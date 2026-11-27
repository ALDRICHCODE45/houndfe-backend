import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import {
  assertNoReservedBulkFilterKeys,
  parseCustomerBulkFilter,
} from './customer-bulk-filter';

function rejection(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  }
  throw new Error('expected a 400');
}

const properties = (body: Record<string, unknown>) =>
  (body.message as Array<{ property: string }>).map((e) => e.property);

describe('parseCustomerBulkFilter (contract §2.1, §2.3, §4.4)', () => {
  it('{} is every customer: no filter', () => {
    expect(parseCustomerBulkFilter({})).toEqual({});
  });

  it('applies the listing DTO rules: booleans, CSV lists, numbers, dates, search', () => {
    expect(
      parseCustomerBulkFilter({
        hasDebt: 'true',
        hasPets: 'false',
        city: ' Zapopan ,León,Zapopan',
        petSpecies: 'DOG,CAT',
        openDebtMin: '100',
        createdFrom: '2026-01-01T00:00:00.000Z',
        search: 'ana',
      }),
    ).toEqual({
      hasDebt: true,
      hasPets: false,
      city: ['Zapopan', 'León'],
      petSpecies: ['DOG', 'CAT'],
      openDebtMin: 100,
      createdFrom: new Date('2026-01-01T00:00:00.000Z'),
      search: 'ana',
    });
  });

  it('drops an empty CSV list (no filter), like the listing', () => {
    expect(parseCustomerBulkFilter({ city: '' })).toEqual({});
  });

  it.each<[Record<string, unknown>, string, string]>([
    [{ openDebtMin: '-1' }, 'LISTING_INVALID_NUMBER', 'openDebtMin'],
    [{ salesCountMin: 'abc' }, 'LISTING_INVALID_NUMBER', 'salesCountMin'],
    [
      { openDebtMin: '500', openDebtMax: '100' },
      'LISTING_INVERTED_RANGE',
      'openDebt',
    ],
    [{ petSpecies: 'FISH' }, 'LISTING_INVALID_ENUM_VALUE', 'petSpecies'],
    [{ priceListId: 'nope' }, 'LISTING_INVALID_UUID', 'priceListId'],
    [{ createdFrom: 'yesterday' }, 'LISTING_INVALID_DATE', 'createdFrom'],
  ])(
    '%j → listing envelope %s naming %s (no filter. prefix)',
    (filter, code, field) => {
      const body = rejection(() => parseCustomerBulkFilter(filter));
      expect(body).toMatchObject({ statusCode: 400, code, field });
    },
  );

  it.each([['page'], ['limit'], ['sortBy'], ['sortOrder']])(
    '%s inside filter → standard 400 naming the key',
    (key) => {
      const body = rejection(() => parseCustomerBulkFilter({ [key]: '1' }));
      expect(body.code).toBeUndefined();
      expect(properties(body)).toEqual([key]);
    },
  );

  it.each<[Record<string, unknown>, string]>([
    [{ preferredPaymentMethod: 'cash' }, 'preferredPaymentMethod'],
    [{ whatever: 'x' }, 'whatever'],
    [{ hasDebt: 'yes' }, 'hasDebt'],
    [{ overdueMoreThanDays: '0' }, 'overdueMoreThanDays'],
  ])('%j → standard per-field 400 on %s', (filter, property) => {
    const body = rejection(() => parseCustomerBulkFilter(filter));
    expect(body.code).toBeUndefined();
    expect(properties(body)).toContain(property);
  });

  it.each<[Record<string, unknown>, string]>([
    [{ hasDebt: true }, 'hasDebt'],
    [{ openDebtMin: 100 }, 'openDebtMin'],
    [{ city: { a: 1 } }, 'city'],
    [{ city: ['Zapopan', 3] }, 'city'],
    [{ search: null }, 'search'],
  ])('%j → values must be URL strings: 400 on %s', (filter, property) => {
    const body = rejection(() => parseCustomerBulkFilter(filter));
    expect(properties(body)).toEqual([property]);
  });

  it('accepts a string array for a CSV param (repeated URL param)', () => {
    expect(parseCustomerBulkFilter({ city: ['Zapopan', 'León'] })).toEqual({
      city: ['Zapopan', 'León'],
    });
  });

  // Advisory R3-filter-proto-key: JSON.parse keeps `__proto__` as an OWN key;
  // it must be rejected like any unknown param, never hit the setter.
  it.each([
    ['{"__proto__":"x"}', '__proto__'],
    ['{"__proto__":["hasDebt"]}', '__proto__'],
    ['{"__proto__":{"hasDebt":"true"}}', '__proto__'],
    ['{"constructor":"x"}', 'constructor'],
    ['{"constructor":["x"]}', 'constructor'],
    ['{"prototype":"x"}', 'prototype'],
    ['{"hasDebt":"true","__proto__":"x"}', '__proto__'],
  ])(
    'own reserved key %s → 400 whitelistValidation on %s',
    (json, property) => {
      const raw = JSON.parse(json) as Record<string, unknown>;
      for (const run of [
        () => parseCustomerBulkFilter(raw),
        () => assertNoReservedBulkFilterKeys(raw),
      ]) {
        const body = rejection(run);
        expect(body.code).toBeUndefined();
        expect(body.message).toEqual([
          expect.objectContaining({
            property,
            constraints: {
              whitelistValidation: `property ${property} should not exist`,
            },
          }),
        ]);
      }
    },
  );

  it('assertNoReservedBulkFilterKeys ignores non-objects and ordinary keys', () => {
    expect(() => assertNoReservedBulkFilterKeys(undefined)).not.toThrow();
    expect(() => assertNoReservedBulkFilterKeys(null)).not.toThrow();
    expect(() => assertNoReservedBulkFilterKeys('x')).not.toThrow();
    expect(() =>
      assertNoReservedBulkFilterKeys({ hasDebt: 'true', nope: 'x' }),
    ).not.toThrow();
  });
});
