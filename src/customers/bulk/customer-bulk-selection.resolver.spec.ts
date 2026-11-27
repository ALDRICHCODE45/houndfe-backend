import 'reflect-metadata';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  CustomerListingRow,
  CustomersListingReadInput,
  CustomersListingReader,
} from '../listing/customer-listing.types';
import type { CustomerBulkSelectionReader } from './customer-bulk-selection.reader';
import { CustomerBulkSelectionResolver } from './customer-bulk-selection.resolver';
import type { CustomerBulkSelectionDto } from './customer-bulk-selection.dto';

const ID_A = '3f2a9c1e-0000-4000-8000-00000000000a';
const ID_B = '3f2a9c1e-0000-4000-8000-00000000000b';
const ID_C = '3f2a9c1e-0000-4000-8000-00000000000c';
/** 23:59 local on 26/11 (Mexico City, UTC-6). */
const NOW = new Date('2026-11-27T05:59:00.000Z');

const withSale = { can: () => true };
const withoutSale = {
  can: (action: string, subject: string) =>
    !(action === 'read' && subject === 'Sale'),
};

function row(id: string): CustomerListingRow {
  return { id } as CustomerListingRow;
}

function world(opts: { count?: number; existing?: string[] } = {}) {
  const calls: {
    page: CustomersListingReadInput[];
    summary: CustomersListingReadInput[];
  } = { page: [], summary: [] };
  let count = opts.count ?? 0;
  let rows: CustomerListingRow[] = [];
  const findPage = jest.fn((input: CustomersListingReadInput) => {
    calls.page.push(input);
    return Promise.resolve(rows);
  });
  const summarize = jest.fn((input: CustomersListingReadInput) => {
    calls.summary.push(input);
    return Promise.resolve({ count });
  });
  const reader: CustomersListingReader = {
    findPage,
    summarize,
    listOptions: jest.fn(),
  };
  const existing = opts.existing;
  const findExistingIds = jest.fn((ids: string[]) =>
    Promise.resolve(existing ? ids.filter((id) => existing.includes(id)) : ids),
  );
  const selectionReader: CustomerBulkSelectionReader = { findExistingIds };
  const config = {
    get: (key: string) =>
      key === 'PROMOTIONS_BUSINESS_TIMEZONE'
        ? 'America/Mexico_City'
        : undefined,
  } as unknown as ConfigService;
  const resolver = new CustomerBulkSelectionResolver(
    reader,
    selectionReader,
    config,
    () => NOW,
  );
  return {
    resolver,
    findPage,
    summarize,
    findExistingIds,
    calls,
    setCount: (n: number) => (count = n),
    setRows: (r: CustomerListingRow[]) => (rows = r),
  };
}

function bodyOf(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(HttpException);
  return (error as HttpException).getResponse() as Record<string, unknown>;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a failure');
}

describe('CustomerBulkSelectionResolver (contract §2)', () => {
  describe('ids mode', () => {
    it('dedupes ids (first occurrence order) and reads only those customers, tenant-checked', async () => {
      const w = world({ count: 2 });
      const resolved = await w.resolver.resolve(
        {
          mode: 'ids',
          customerIds: [ID_A, ID_B, ID_A],
        } as CustomerBulkSelectionDto,
        { ability: withSale, max: 10 },
      );
      expect(w.findExistingIds).toHaveBeenCalledWith([ID_A, ID_B]);
      expect(resolved.mode).toBe('ids');
      expect(resolved.count).toBe(2);
      expect(resolved.canReadSale).toBe(true);
      expect(resolved.input.filters).toEqual({});
      expect(resolved.input.ids).toEqual({ include: [ID_A, ID_B] });
      expect(w.calls.summary[0].ids).toEqual({ include: [ID_A, ID_B] });
    });

    it('any unknown / foreign / deleted id → 404 BULK_CUSTOMERS_NOT_FOUND with details.missingIds, before the count', async () => {
      const w = world({ count: 1, existing: [ID_B] });
      const error = await failure(
        w.resolver.resolve(
          {
            mode: 'ids',
            customerIds: [ID_C, ID_B, ID_A, ID_C],
          } as CustomerBulkSelectionDto,
          { ability: withSale, max: 10 },
        ),
      );
      expect(error).toBeInstanceOf(NotFoundException);
      expect(bodyOf(error)).toEqual({
        statusCode: 404,
        code: 'BULK_CUSTOMERS_NOT_FOUND',
        message: '2 customers not found',
        field: 'customerIds',
        details: { missingIds: [ID_C, ID_A] },
      });
      expect(w.summarize).not.toHaveBeenCalled();
    });

    it('metric sortBy without read:Sale → 400 LISTING_PARAM_REQUIRES_PERMISSION field sortBy, before reading', async () => {
      const w = world({ count: 1 });
      const error = await failure(
        w.resolver.resolve(
          { mode: 'ids', customerIds: [ID_A] } as CustomerBulkSelectionDto,
          { ability: withoutSale, max: 10, sortBy: 'openDebt' },
        ),
      );
      expect(bodyOf(error)).toMatchObject({
        code: 'LISTING_PARAM_REQUIRES_PERMISSION',
        field: 'sortBy',
        details: { required: 'read:Sale' },
      });
      expect(w.findExistingIds).not.toHaveBeenCalled();
    });
  });

  describe('filter mode', () => {
    it('validates the filter with the listing rules, applies excludeIds (deduped) and the listing defaults', async () => {
      const w = world({ count: 3 });
      const resolved = await w.resolver.resolve(
        {
          mode: 'filter',
          filter: { hasDebt: 'true', city: 'Zapopan' },
          excludeIds: [ID_A, ID_A],
        } as CustomerBulkSelectionDto,
        { ability: withSale, max: 10 },
      );
      expect(resolved.input).toEqual({
        filters: { hasDebt: true, city: ['Zapopan'] },
        ids: { exclude: [ID_A] },
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: 1,
        limit: 11,
        metrics: {
          overdueBefore: new Date('2026-11-26T00:00:00.000Z'),
          timeZone: 'America/Mexico_City',
        },
      });
      expect(w.findExistingIds).not.toHaveBeenCalled();
    });

    it('no excludeIds → no id condition at all', async () => {
      const w = world({ count: 0 });
      const resolved = await w.resolver.resolve(
        { mode: 'filter', filter: {} } as CustomerBulkSelectionDto,
        { ability: withSale, max: 10, sortBy: 'name', sortOrder: 'asc' },
      );
      expect(resolved.input.ids).toBeUndefined();
      expect(resolved.input.sortBy).toBe('name');
      expect(resolved.input.sortOrder).toBe('asc');
      expect(resolved.count).toBe(0);
    });

    it('without read:Sale: metrics null; a metric filter → 400 naming the plain listing param', async () => {
      const w = world({ count: 1 });
      const ok = await w.resolver.resolve(
        {
          mode: 'filter',
          filter: { city: 'León' },
        } as CustomerBulkSelectionDto,
        { ability: withoutSale, max: 10 },
      );
      expect(ok.canReadSale).toBe(false);
      expect(ok.input.metrics).toBeNull();

      const error = await failure(
        w.resolver.resolve(
          {
            mode: 'filter',
            filter: { city: 'León', openDebtMin: '1', hasDebt: 'false' },
          } as CustomerBulkSelectionDto,
          { ability: withoutSale, max: 10 },
        ),
      );
      expect(bodyOf(error)).toEqual({
        statusCode: 400,
        code: 'LISTING_PARAM_REQUIRES_PERMISSION',
        message: 'hasDebt requires read:Sale',
        field: 'hasDebt',
        details: { required: 'read:Sale' },
      });
    });

    it('a filter validation error comes before the permission check (listing order)', async () => {
      const w = world();
      const error = await failure(
        w.resolver.resolve(
          {
            mode: 'filter',
            filter: { openDebtMin: '-1' },
          } as CustomerBulkSelectionDto,
          { ability: withoutSale, max: 10 },
        ),
      );
      expect(bodyOf(error)).toMatchObject({
        code: 'LISTING_INVALID_NUMBER',
        field: 'openDebtMin',
      });
    });
  });

  describe('size', () => {
    it('count > max → 400 BULK_SELECTION_TOO_LARGE {count, max}, before any row is read', async () => {
      const w = world({ count: 11 });
      const error = await failure(
        w.resolver.resolve(
          { mode: 'filter', filter: {} } as CustomerBulkSelectionDto,
          { ability: withSale, max: 10 },
        ),
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(bodyOf(error)).toEqual({
        statusCode: 400,
        code: 'BULK_SELECTION_TOO_LARGE',
        message: 'selection resolves to 11 customers; max 10',
        field: 'selection',
        details: { count: 11, max: 10 },
      });
      expect(w.findPage).not.toHaveBeenCalled();
    });

    it('count === max is allowed', async () => {
      const w = world({ count: 10 });
      await expect(
        w.resolver.resolve(
          { mode: 'filter', filter: {} } as CustomerBulkSelectionDto,
          {
            ability: withSale,
            max: 10,
          },
        ),
      ).resolves.toMatchObject({ count: 10 });
    });

    it('rejectEmpty: 0 customers → 400 BULK_SELECTION_EMPTY (statements); default allows 0', async () => {
      const w = world({ count: 0 });
      const error = await failure(
        w.resolver.resolve(
          { mode: 'filter', filter: {} } as CustomerBulkSelectionDto,
          {
            ability: withSale,
            max: 50,
            rejectEmpty: true,
          },
        ),
      );
      expect(bodyOf(error)).toEqual({
        statusCode: 400,
        code: 'BULK_SELECTION_EMPTY',
        message: 'selection resolves to 0 customers',
        field: 'selection',
      });
    });
  });

  describe('readRows / readIds', () => {
    it('reads page 1 with limit max+1 and returns the rows in SQL order', async () => {
      const w = world({ count: 2 });
      const resolved = await w.resolver.resolve(
        { mode: 'filter', filter: {} } as CustomerBulkSelectionDto,
        { ability: withSale, max: 10 },
      );
      w.setRows([row(ID_B), row(ID_A)]);
      await expect(w.resolver.readRows(resolved)).resolves.toEqual([
        row(ID_B),
        row(ID_A),
      ]);
      await expect(w.resolver.readIds(resolved)).resolves.toEqual([ID_B, ID_A]);
      expect(w.calls.page[0]).toMatchObject({ page: 1, limit: 11 });
    });

    it('rows past the cap (customers created after the count) → 400 BULK_SELECTION_TOO_LARGE', async () => {
      const w = world({ count: 2 });
      const resolved = await w.resolver.resolve(
        { mode: 'filter', filter: {} } as CustomerBulkSelectionDto,
        { ability: withSale, max: 2 },
      );
      w.setRows([row(ID_A), row(ID_B), row(ID_C)]);
      const error = await failure(w.resolver.readRows(resolved));
      expect(bodyOf(error)).toMatchObject({
        code: 'BULK_SELECTION_TOO_LARGE',
        details: { count: 3, max: 2 },
      });
    });

    it('ids mode: a customer deleted between the check and the read → 404 with that id', async () => {
      const w = world({ count: 2 });
      const resolved = await w.resolver.resolve(
        { mode: 'ids', customerIds: [ID_A, ID_B] } as CustomerBulkSelectionDto,
        { ability: withSale, max: 10 },
      );
      w.setRows([row(ID_A)]);
      const error = await failure(w.resolver.readRows(resolved));
      expect(bodyOf(error)).toMatchObject({
        code: 'BULK_CUSTOMERS_NOT_FOUND',
        details: { missingIds: [ID_B] },
      });
    });
  });
});
