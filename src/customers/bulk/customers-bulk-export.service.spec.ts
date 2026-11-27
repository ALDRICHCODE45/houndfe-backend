import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { CustomerListingRow } from '../listing/customer-listing.types';
import type { CustomerBulkSelectionResolver } from './customer-bulk-selection.resolver';
import type { CustomersBulkExportBodyDto } from './customers-bulk-export.dto';
import {
  CUSTOMERS_CSV_MAX_ROWS,
  CustomersBulkExportService,
} from './customers-bulk-export.service';

const NOW = new Date('2026-11-27T05:59:00.000Z'); // 26/11 23:59 local
const config = {
  get: (key: string) =>
    key === 'PROMOTIONS_BUSINESS_TIMEZONE' ? 'America/Mexico_City' : undefined,
} as unknown as ConfigService;

const ROW = {
  id: '3f2a9c1e-0000-4000-8000-000000000001',
  firstName: 'Secreta',
  lastName: 'Persona',
  businessName: null,
  phoneCountryCode: null,
  phone: '5599998888',
  email: 'secreta@example.com',
  globalPriceList: null,
  rfc: null,
  fiscalRegime: null,
  preferredPaymentMethod: null,
  isTrusted: false,
  createdAt: '2026-03-02T17:04:11.000Z',
  primaryAddress: null,
  activePetsCount: 0,
  petSpecies: [],
  matchedPetName: null,
} satisfies CustomerListingRow;

function world(canReadSale: boolean, rows: CustomerListingRow[] = [ROW]) {
  const resolved = {
    mode: 'filter' as const,
    count: rows.length,
    canReadSale,
    max: CUSTOMERS_CSV_MAX_ROWS,
    input: {} as never,
  };
  const resolver = {
    resolve: jest.fn().mockResolvedValue(resolved),
    readRows: jest.fn().mockResolvedValue(rows),
  };
  const service = new CustomersBulkExportService(
    resolver as unknown as CustomerBulkSelectionResolver,
    config,
    () => NOW,
  );
  return { service, resolver };
}

const ability = { can: () => true };
const actor = { userId: 'user-1', tenantId: 'tenant-1' };

describe('CustomersBulkExportService (contract §4, owner L2.1)', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  it('caps at 10,000 rows and forwards the selection and the table sort', async () => {
    expect(CUSTOMERS_CSV_MAX_ROWS).toBe(10_000);
    const { service, resolver } = world(true);
    const body = {
      selection: { mode: 'filter', filter: { hasDebt: 'true' } },
      sortBy: 'openDebt',
      sortOrder: 'asc',
    } as CustomersBulkExportBodyDto;
    await service.export(body, ability, actor);
    expect(resolver.resolve).toHaveBeenCalledWith(body.selection, {
      ability,
      max: 10_000,
      sortBy: 'openDebt',
      sortOrder: 'asc',
    });
  });

  it('local business-date filename, metric columns only with read:Sale', async () => {
    const withSale = await world(true, [
      {
        ...ROW,
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
      },
    ]).service.export(
      {
        selection: { mode: 'filter', filter: {} },
      } as CustomersBulkExportBodyDto,
      ability,
      actor,
    );
    expect(withSale.filename).toBe('clientes-2026-11-26.csv');
    expect(withSale.withMetrics).toBe(true);
    expect(withSale.rowCount).toBe(1);
    expect(withSale.csv.toString('utf8')).toContain(',Deuda,');

    const withoutSale = await world(false).service.export(
      {
        selection: { mode: 'filter', filter: {} },
      } as CustomersBulkExportBodyDto,
      ability,
      actor,
    );
    expect(withoutSale.withMetrics).toBe(false);
    expect(withoutSale.csv.toString('utf8')).not.toContain('Deuda');
  });

  it('writes ONE structured log line: who, tenant, mode, row count — no customer data', async () => {
    const { service } = world(true);
    await service.export(
      {
        selection: { mode: 'filter', filter: { search: 'Secreta' } },
      } as CustomersBulkExportBodyDto,
      ability,
      actor,
    );
    expect(log).toHaveBeenCalledTimes(1);
    const line = String((log.mock.calls[0] as unknown[])[0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event: 'customers.bulk.export',
      outcome: 'ok',
      tenantId: 'tenant-1',
      userId: 'user-1',
      mode: 'filter',
      rowCount: 1,
      withMetrics: true,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
    expect(typeof parsed.durationMs).toBe('number');
    expect(line).not.toMatch(
      /Secreta|Persona|5599998888|secreta@example|3f2a9c1e/,
    );
  });

  it('a failed export is logged once with its code and rethrown', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service, resolver } = world(true);
    const error = Object.assign(new Error('x'), {
      getResponse: () => ({ code: 'BULK_SELECTION_TOO_LARGE' }),
    });
    resolver.resolve.mockRejectedValue(error);
    await expect(
      service.export(
        {
          selection: { mode: 'ids', customerIds: ['a'] },
        } as CustomersBulkExportBodyDto,
        ability,
        actor,
      ),
    ).rejects.toBe(error);
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String((warn.mock.calls[0] as unknown[])[0])),
    ).toMatchObject({
      event: 'customers.bulk.export',
      outcome: 'rejected',
      code: 'BULK_SELECTION_TOO_LARGE',
      mode: 'ids',
    });
    warn.mockRestore();
  });

  // Advisory R3-denied-export-unlogged.
  it('logDenied writes ONE forbidden warn line: who, tenant, mode, reason — no customer data', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service, resolver } = world(true);
    service.logDenied(
      {
        selection: { mode: 'ids', customerIds: [ROW.id] },
      } as CustomersBulkExportBodyDto,
      actor,
      'EXPORT_PERMISSION_NOT_EXPLICIT',
    );
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String((warn.mock.calls[0] as unknown[])[0]);
    expect(JSON.parse(line)).toEqual({
      event: 'customers.bulk.export',
      tenantId: 'tenant-1',
      userId: 'user-1',
      mode: 'ids',
      outcome: 'forbidden',
      code: 'INSUFFICIENT_PERMISSIONS',
      reason: 'EXPORT_PERMISSION_NOT_EXPLICIT',
    });
    expect(line).not.toMatch(/3f2a9c1e/);
    warn.mockRestore();
  });
});
