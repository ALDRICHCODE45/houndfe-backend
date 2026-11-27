/**
 * customers-bulk-actions / T3 (S5) — `CustomerBulkStatementsService`:
 * selection (cap 50, name order, empty rejected) → one statement PDF per
 * customer through the single statement path, rendered one at a time with a
 * yield between renders → ZIP; one bulk run per process; one log line per run.
 */
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import {
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { inflateRawSync } from 'node:zlib';
import type { AppAbility } from '../auth/authorization/domain/permission';
import type { CustomerBulkSelectionResolver } from '../customers/bulk';
import type { PdfGenerationService } from '../pdf-generation/pdf-generation.service';
import {
  BulkExportBusyException,
  CustomerBulkStatementsRunGuard,
} from './customer-bulk-statements.busy-guard';
import {
  BulkStatementsAbortedError,
  BULK_STATEMENTS_MAX_CUSTOMERS,
  CustomerBulkStatementsService,
} from './customer-bulk-statements.service';
import type { CustomerStatementService } from './customer-statement.service';
import type { CustomerBulkStatementsBodyDto } from './dto/customer-bulk-statements.dto';
import type { CustomerStatementDto } from './dto/customer-statement.dto';

/** Minimal central-directory reader: `[name, data, dosDate, dosTime]`. */
function readZip(
  zip: Buffer,
): Array<{ name: string; data: Buffer; dosDate: number; dosTime: number }> {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: Array<{
    name: string;
    data: Buffer;
    dosDate: number;
    dosTime: number;
  }> = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const dosTime = zip.readUInt16LE(p + 12);
    const dosDate = zip.readUInt16LE(p + 14);
    const size = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30);
    const comment = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    out.push({
      name,
      data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw),
      dosDate,
      dosTime,
    });
    p += 46 + nameLength + extra + comment;
  }
  return out;
}

function ability(): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  can('read', 'Sale');
  can('read', 'Customer');
  return build();
}

const ID_A = '3f2a9c1e-0000-4000-8000-000000000001';
const ID_B = '7b1d2e3f-0000-4000-8000-000000000002';
const ID_C = 'a1b2c3d4-0000-4000-8000-000000000003';
// 2026-11-27 10:15:20 in Mexico City (UTC-6).
const NOW = new Date('2026-11-27T16:15:20.000Z');

const rows = [
  { id: ID_A, firstName: 'Ana', lastName: 'López' },
  { id: ID_B, firstName: 'ana', lastName: 'López' },
  { id: ID_C, firstName: 'Bruno', lastName: null },
];

const body = {
  selection: { mode: 'ids', customerIds: [ID_C, ID_A, ID_B] },
  from: '2026-11-01',
  to: '2026-12-01',
} as unknown as CustomerBulkStatementsBodyDto;
const actor = { userId: 'user-1', tenantId: 'tenant-1' };

function world(
  options: {
    rows?: typeof rows;
    render?: (statement: CustomerStatementDto) => Promise<Buffer>;
    getStatement?: (id: string) => Promise<CustomerStatementDto>;
  } = {},
) {
  const events: string[] = [];
  const resolved = { mode: 'ids', count: (options.rows ?? rows).length };
  const resolver = {
    resolve: jest.fn().mockResolvedValue(resolved),
    readRows: jest.fn().mockResolvedValue(options.rows ?? rows),
  };
  const statementService = {
    getStatement: jest.fn(
      options.getStatement ??
        ((id: string) =>
          Promise.resolve({ customer: { id } } as CustomerStatementDto)),
    ),
  };
  const pdf = {
    renderCustomerStatementPdf: jest.fn(
      options.render ??
        ((statement: CustomerStatementDto) => {
          events.push(`render:${statement.customer.id}`);
          // Anything queued during a render must run before the next one.
          setImmediate(() => events.push(`immediate:${statement.customer.id}`));
          return Promise.resolve(Buffer.from(`%PDF-${statement.customer.id}`));
        }),
    ),
  };
  const guard = new CustomerBulkStatementsRunGuard();
  const config = {
    get: (key: string) =>
      key === 'PROMOTIONS_BUSINESS_TIMEZONE'
        ? 'America/Mexico_City'
        : undefined,
  };
  const service = new CustomerBulkStatementsService(
    resolver as unknown as CustomerBulkSelectionResolver,
    statementService as unknown as CustomerStatementService,
    pdf as unknown as PdfGenerationService,
    guard,
    config as never,
    () => NOW,
  );
  return { service, resolver, statementService, pdf, guard, events, resolved };
}

describe('CustomerBulkStatementsService', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const logged = (): Array<Record<string, unknown>> =>
    [
      ...(log.mock.calls as unknown[][]),
      ...(warn.mock.calls as unknown[][]),
    ].map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

  it('resolves the selection with cap 50, name asc, empty rejected and the caller ability', async () => {
    const { service, resolver, resolved } = world();
    const a = ability();
    await service.build(body, a, actor);

    expect(BULK_STATEMENTS_MAX_CUSTOMERS).toBe(50);
    expect(resolver.resolve).toHaveBeenCalledWith(body.selection, {
      ability: a,
      max: 50,
      sortBy: 'name',
      sortOrder: 'asc',
      rejectEmpty: true,
    });
    expect(resolver.readRows).toHaveBeenCalledWith(resolved);
  });

  it('one PDF per customer in the resolved order, each exactly the single statement path output (same reader + renderer, same period)', async () => {
    const { service, statementService, pdf } = world();
    const result = await service.build(body, ability(), actor);

    expect(statementService.getStatement.mock.calls).toEqual([
      [ID_A, { from: '2026-11-01', to: '2026-12-01' }],
      [ID_B, { from: '2026-11-01', to: '2026-12-01' }],
      [ID_C, { from: '2026-11-01', to: '2026-12-01' }],
    ]);
    expect(pdf.renderCustomerStatementPdf).toHaveBeenCalledTimes(3);

    const entries = readZip(result.zip);
    expect(entries.map((e) => e.name)).toEqual([
      'Ana López.pdf',
      'ana López (2).pdf',
      'Bruno.pdf',
    ]);
    expect(entries.map((e) => e.data.toString())).toEqual([
      `%PDF-${ID_A}`,
      `%PDF-${ID_B}`,
      `%PDF-${ID_C}`,
    ]);
    expect(result).toMatchObject({
      filename: 'estados-de-cuenta-2026-11-01-2026-12-01.zip',
      count: 3,
      entryNames: ['Ana López.pdf', 'ana López (2).pdf', 'Bruno.pdf'],
    });
  });

  it('ZIP entry timestamps are the business local wall time (Mexico City)', async () => {
    const { service } = world();
    const [entry] = readZip((await service.build(body, ability(), actor)).zip);
    // 2026-11-27 10:15:20 local.
    expect(entry.dosDate).toBe(((2026 - 1980) << 9) | (11 << 5) | 27);
    expect(entry.dosTime).toBe((10 << 11) | (15 << 5) | (20 >> 1));
  });

  it('renders one PDF at a time and yields to the event loop between renders', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const events: string[] = [];
    const { service } = world({
      render: async (statement) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(`render:${statement.customer.id}`);
        setImmediate(() => events.push(`immediate:${statement.customer.id}`));
        await Promise.resolve();
        inFlight--;
        return Buffer.from('%PDF');
      },
    });
    await service.build(body, ability(), actor);

    expect(maxInFlight).toBe(1);
    expect(events).toEqual([
      `render:${ID_A}`,
      `immediate:${ID_A}`,
      `render:${ID_B}`,
      `immediate:${ID_B}`,
      `render:${ID_C}`,
      `immediate:${ID_C}`,
    ]);
  });

  it('a customer deleted mid-run (single path 404 CUSTOMER_NOT_FOUND) → 404 BULK_CUSTOMERS_NOT_FOUND with that id', async () => {
    const { service, guard } = world({
      getStatement: (id) =>
        id === ID_B
          ? Promise.reject(
              new HttpException(
                {
                  statusCode: 404,
                  error: 'CUSTOMER_NOT_FOUND',
                  message: 'CUSTOMER_NOT_FOUND',
                },
                404,
              ),
            )
          : Promise.resolve({ customer: { id } } as CustomerStatementDto),
    });
    const error = (await service
      .build(body, ability(), actor)
      .catch((e: unknown) => e)) as HttpException;

    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toMatchObject({
      code: 'BULK_CUSTOMERS_NOT_FOUND',
      details: { missingIds: [ID_B] },
    });
    expect(guard.busy).toBe(false);
  });

  it('a render failure → 500 PDF_GENERATION_FAILED for the whole request; the slot is released', async () => {
    const { service, guard, pdf } = world({
      render: () =>
        Promise.reject(
          new InternalServerErrorException('PDF_GENERATION_FAILED'),
        ),
    });
    await expect(service.build(body, ability(), actor)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(pdf.renderCustomerStatementPdf).toHaveBeenCalledTimes(1);
    expect(guard.busy).toBe(false);
    expect(logged()).toEqual([
      expect.objectContaining({
        event: 'customers.bulk.statements',
        outcome: 'failed',
        code: 'PDF_GENERATION_FAILED',
      }),
    ]);
  });

  it('a selection error (e.g. too large) is logged as rejected and releases the slot', async () => {
    const { service, resolver, guard } = world();
    resolver.resolve.mockRejectedValueOnce(
      new HttpException(
        { statusCode: 400, code: 'BULK_SELECTION_TOO_LARGE' },
        400,
      ),
    );
    await expect(service.build(body, ability(), actor)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(guard.busy).toBe(false);
    expect(logged()).toEqual([
      expect.objectContaining({
        outcome: 'rejected',
        code: 'BULK_SELECTION_TOO_LARGE',
      }),
    ]);
  });

  it('a second run while one is in progress → 429 BULK_EXPORT_BUSY, nothing resolved for it; logged as busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, resolver } = world({
      render: async () => {
        await gate;
        return Buffer.from('%PDF');
      },
    });
    const first = service.build(body, ability(), actor);
    await new Promise(setImmediate);

    await expect(service.build(body, ability(), actor)).rejects.toBeInstanceOf(
      BulkExportBusyException,
    );
    expect(resolver.resolve).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ count: 3 });
    expect(
      logged()
        .map((line) => line.outcome)
        .sort(),
    ).toEqual(['busy', 'ok']);
  });

  it('a client abort stops before the next render, releases the slot, logs aborted', async () => {
    const controller = new AbortController();
    const { service, guard, pdf } = world({
      render: () => {
        controller.abort();
        return Promise.resolve(Buffer.from('%PDF'));
      },
    });
    await expect(
      service.build(body, ability(), actor, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(BulkStatementsAbortedError);
    expect(pdf.renderCustomerStatementPdf).toHaveBeenCalledTimes(1);
    expect(guard.busy).toBe(false);
    expect(logged()).toEqual([expect.objectContaining({ outcome: 'aborted' })]);
  });

  it('one structured log line per successful run: user, tenant, mode, count, period, outcome, duration, size; no customer data', async () => {
    const { service } = world();
    const result = await service.build(body, ability(), actor);

    const lines = logged();
    const anyNumber: unknown = expect.any(Number);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      event: 'customers.bulk.statements',
      userId: 'user-1',
      tenantId: 'tenant-1',
      mode: 'ids',
      from: '2026-11-01',
      to: '2026-12-01',
      outcome: 'ok',
      count: 3,
      zipBytes: result.zip.length,
      renderMsTotal: anyNumber,
      renderMsMax: anyNumber,
      durationMs: anyNumber,
    });
    const text = JSON.stringify(lines);
    for (const value of ['Ana', 'López', 'Bruno', ID_A, ID_B, ID_C]) {
      expect(text).not.toContain(value);
    }
  });
});
