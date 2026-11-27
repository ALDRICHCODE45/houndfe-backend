/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped JSON */
/**
 * customers-bulk-actions / T3 (S5) — `POST /customers/bulk/statements`
 * against REAL PostgreSQL through the real JWT → tenant → CASL chain, the
 * production validation pipe, the real selection resolver (listing SQL), the
 * real `PrismaCustomerStatementReader` and the real
 * `PdfGenerationService.renderCustomerStatementPdf` (Yoga is mocked under
 * Jest — see jest config — so render times here are NOT production times).
 *
 * The single statement route is mounted in the same app: every ZIP entry is
 * compared with what `GET /customers/:id/statement/pdf` returns for the same
 * customer and period (both read with the same pinned sales clock).
 */
import { Logger, type INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaCustomerBulkSelectionReader } from '../customers/bulk/customer-bulk-selection.reader';
import { CustomerBulkSelectionResolver } from '../customers/bulk';
import { PrismaCustomersListingReader } from '../customers/listing/prisma-customers-listing.reader';
import {
  createZoneTestApp,
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../delivery-zones/test-support/delivery-zone-world';
import { PdfGenerationService } from '../pdf-generation/pdf-generation.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { CustomerBulkStatementsRunGuard } from './customer-bulk-statements.busy-guard';
import { CustomerBulkStatementsController } from './customer-bulk-statements.controller';
import { CustomerBulkStatementsService } from './customer-bulk-statements.service';
import { CustomerStatementService } from './customer-statement.service';
import type { CustomerStatementDto } from './dto/customer-statement.dto';
import { PrismaCustomerStatementReader } from './infrastructure/prisma-customer-statement.reader';
import { SalesCustomerStatementController } from './sales-customer-statement.controller';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

const HOUR = 3_600_000;
/** UTC instant of 00:00 local (UTC-6) on a `YYYY-MM-DD` local date. */
const mxMidnight = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + 6 * HOUR);
const FROM = '2026-03-01';
const TO = '2026-04-01';
// Pinned clock: 2026-11-25 12:00 in Mexico City.
const NOW = new Date('2026-11-25T18:00:00.000Z');

const config = {
  get: (key: string) =>
    key === 'PROMOTIONS_BUSINESS_TIMEZONE' ? 'America/Mexico_City' : undefined,
} as unknown as ConfigService;

/** Collects the raw response body into a Buffer. */
const asBuffer = (test: request.Test) =>
  test.buffer(true).parse((response, callback) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  });

interface ZipEntry {
  name: string;
  data: Buffer;
  method: number;
  compressedSize: number;
}

/** Reads the archive from its central directory; checks signatures + CRCs. */
function readZip(zip: Buffer): ZipEntry[] {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  expect(zip.readUInt32LE(eocd + 12) + zip.readUInt32LE(eocd + 16)).toBe(eocd);
  let p = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compressedSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30);
    const comment = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(size);
    expect(crc32(data) >>> 0).toBe(crc);
    entries.push({ name, data, method, compressedSize });
    p += 46 + nameLength + extra + comment;
  }
  return entries;
}

describeIfDb('POST /customers/bulk/statements (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;
  const renderMs: number[] = [];
  /** When set, every render waits for it (concurrency test). */
  let gate: Promise<void> | null = null;
  let renderStarted: (() => void) | null = null;
  /** Releases `gate`; also called in `afterEach` so nothing stays pending. */
  let releaseGate: (() => void) | null = null;

  beforeAll(async () => {
    // Real render method without `onModuleInit` (no font CDN preflight).
    const pdf = Object.create(
      PdfGenerationService.prototype,
    ) as PdfGenerationService;
    Object.assign(pdf, { logger: new Logger('BulkStatementsSpec') });
    app = await createZoneTestApp({
      controllers: [
        SalesCustomerStatementController,
        CustomerBulkStatementsController,
      ],
      providers: [
        {
          provide: CustomerStatementService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) =>
            new CustomerStatementService(
              new PrismaCustomerStatementReader(tenantPrisma),
              () => NOW,
              config,
            ),
        },
        {
          provide: PdfGenerationService,
          useValue: {
            renderCustomerStatementPdf: async (
              statement: CustomerStatementDto,
            ) => {
              renderStarted?.();
              if (gate) await gate;
              const t0 = performance.now();
              const out = await pdf.renderCustomerStatementPdf(statement);
              renderMs.push(performance.now() - t0);
              return out;
            },
          },
        },
        {
          provide: CustomerBulkSelectionResolver,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) =>
            new CustomerBulkSelectionResolver(
              new PrismaCustomersListingReader(tenantPrisma),
              new PrismaCustomerBulkSelectionReader(tenantPrisma),
              config,
              () => NOW,
            ),
        },
        CustomerBulkStatementsRunGuard,
        {
          provide: CustomerBulkStatementsService,
          inject: [
            CustomerBulkSelectionResolver,
            CustomerStatementService,
            PdfGenerationService,
            CustomerBulkStatementsRunGuard,
          ],
          useFactory: (
            resolver: CustomerBulkSelectionResolver,
            statements: CustomerStatementService,
            pdfService: PdfGenerationService,
            guard: CustomerBulkStatementsRunGuard,
          ) =>
            new CustomerBulkStatementsService(
              resolver,
              statements,
              pdfService,
              guard,
              config,
              () => NOW,
            ),
        },
      ],
    });
  });

  afterEach(async () => {
    releaseGate?.();
    releaseGate = null;
    renderMs.length = 0;
    gate = null;
    renderStarted = null;
    await world.cleanup();
  });

  afterAll(async () => {
    await app?.close();
    await disconnectWorldPrisma();
  });

  interface Branch {
    tenantId: string;
    member: SeededMember;
  }

  async function branch(
    name: string,
    grants = ['Sale:read', 'Customer:read'],
  ): Promise<Branch> {
    const tenantId = await world.tenant(name);
    const member = await world.member(tenantId, `Cajero ${name}`, grants);
    return { tenantId, member };
  }

  async function customer(
    b: Branch,
    firstName: string,
    lastName: string | null = null,
    id: string = randomUUID(),
  ): Promise<string> {
    await prisma.customer.create({
      data: { id, tenantId: b.tenantId, firstName, lastName },
    });
    return id;
  }

  let seq = 0;
  /** `count` confirmed sales in the period (half on credit) + a payment each. */
  async function activity(b: Branch, customerId: string, count: number) {
    for (let i = 0; i < count; i++) {
      const saleId = randomUUID();
      const total = 10_000 + i * 150;
      const debt = i % 2 === 0 ? 0 : 4_000;
      const confirmedAt = new Date(
        mxMidnight('2026-03-02').getTime() + i * 20 * HOUR,
      );
      await prisma.sale.create({
        data: {
          id: saleId,
          tenantId: b.tenantId,
          userId: b.member.userId,
          customerId,
          status: 'CONFIRMED',
          channel: 'POS',
          folio: `BS-${++seq}`,
          confirmedAt,
          subtotalCents: total,
          totalCents: total,
          paidCents: total - debt,
          debtCents: debt,
          paymentStatus: debt === 0 ? 'PAID' : 'PARTIAL',
          dueDate: debt === 0 ? null : new Date('2026-04-15T00:00:00.000Z'),
        },
      });
      await prisma.salePayment.create({
        data: {
          saleId,
          tenantId: b.tenantId,
          method: i % 3 === 0 ? 'CASH' : 'TRANSFER',
          amountCents: total - debt,
          createdAt: confirmedAt,
        },
      });
    }
  }

  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  const bulk = (b: Branch, payload: object) =>
    request(server())
      .post('/customers/bulk/statements')
      .set(auth(b.member))
      .send(payload);
  const bulkZip = (b: Branch, payload: object) => asBuffer(bulk(b, payload));
  const single = (b: Branch, customerId: string) =>
    asBuffer(
      request(server())
        .get(`/customers/${customerId}/statement/pdf?from=${FROM}&to=${TO}`)
        .set(auth(b.member)),
    );

  it('ids mode: ZIP with one PDF per customer in name order, each identical to the single route PDF; customers without movements included; equal names disambiguated', async () => {
    const b = await branch('BulkEdoA');
    // Equal display names; the name sort ties on id → order by id.
    const [anaLow, anaHigh] = [randomUUID(), randomUUID()].sort();
    const zoe = await customer(b, 'Zoé', 'Álvarez');
    await customer(b, 'Ana', 'López', anaHigh);
    await customer(b, 'ana', 'lópez', anaLow);
    const bruno = await customer(b, 'Bruno'); // no movements at all
    await activity(b, zoe, 20);
    await activity(b, anaHigh, 5);

    const res = await bulkZip(b, {
      selection: { mode: 'ids', customerIds: [zoe, anaHigh, bruno, anaLow] },
      from: FROM,
      to: TO,
    }).expect(200);

    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="estados-de-cuenta-${FROM}-${TO}.zip"`,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const zip = res.body as Buffer;
    expect(res.headers['content-length']).toBe(String(zip.length));

    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'ana lópez.pdf',
      'Ana López (2).pdf',
      'Bruno.pdf',
      'Zoé Álvarez.pdf',
    ]);
    const order = [anaLow, anaHigh, bruno, zoe];
    for (const [index, id] of order.entries()) {
      const pdf = (await single(b, id).expect(200)).body as Buffer;
      const entry = entries[index].data;
      expect(entry.subarray(0, 5).toString()).toBe('%PDF-');
      // Byte-for-byte (same clock-pinned statement, same renderer). The PDF
      // carries no render timestamp: `generatedAt` comes from the sales clock.
      expect(entry.equals(pdf)).toBe(true);
    }

    // Contract gate (§3.3): render time per PDF and ZIP size — reported.
    const bulkRenders = renderMs.slice(0, order.length);
    console.log(
      JSON.stringify({
        gate: 'bulk-statements-render',
        note: 'Jest maps yoga-layout to a stub: layout cost is not production cost',
        renderMs: bulkRenders.map((ms) => Math.round(ms * 10) / 10),
        pdfBytes: entries.map((e) => e.data.length),
        compressedBytes: entries.map((e) => e.compressedSize),
        methods: entries.map((e) => e.method),
        zipBytes: zip.length,
      }),
    );
  });

  it('filter mode with excludeIds: every matching customer except the excluded, name order', async () => {
    const b = await branch('BulkEdoFiltro');
    const ana = await customer(b, 'Ana');
    const beto = await customer(b, 'Beto');
    const carla = await customer(b, 'Carla');
    await activity(b, carla, 1);

    const res = await bulkZip(b, {
      selection: { mode: 'filter', filter: {}, excludeIds: [beto] },
      from: FROM,
      to: TO,
    }).expect(200);
    expect(readZip(res.body as Buffer).map((e) => e.name)).toEqual([
      'Ana.pdf',
      'Carla.pdf',
    ]);
    expect(ana).toBeDefined();

    // A listing filter narrows it (search).
    const narrowed = await bulkZip(b, {
      selection: { mode: 'filter', filter: { search: 'carla' } },
      from: FROM,
      to: TO,
    }).expect(200);
    expect(readZip(narrowed.body as Buffer).map((e) => e.name)).toEqual([
      'Carla.pdf',
    ]);
  });

  it('ids mode is strict: an unknown or foreign-branch id → 404 BULK_CUSTOMERS_NOT_FOUND with every missing id, nothing rendered', async () => {
    const a = await branch('BulkEdoNoA');
    const other = await branch('BulkEdoNoB');
    const mine = await customer(a, 'Ana');
    const foreign = await customer(other, 'Foránea');
    const unknown = randomUUID();

    const res = await bulk(a, {
      selection: { mode: 'ids', customerIds: [mine, foreign, unknown] },
      from: FROM,
      to: TO,
    }).expect(404);
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'BULK_CUSTOMERS_NOT_FOUND',
      message: '2 customers not found',
      field: 'customerIds',
      details: { missingIds: [foreign, unknown] },
    });
    expect(renderMs).toHaveLength(0);
  });

  it('tenant isolation: filter mode only sees the caller branch', async () => {
    const a = await branch('BulkEdoIsoA');
    const other = await branch('BulkEdoIsoB');
    await customer(a, 'Propia');
    await customer(other, 'Ajena');
    await customer(other, 'Otra ajena');

    const res = await bulkZip(a, {
      selection: { mode: 'filter', filter: {} },
      from: FROM,
      to: TO,
    }).expect(200);
    expect(readZip(res.body as Buffer).map((e) => e.name)).toEqual([
      'Propia.pdf',
    ]);
  });

  it('more than 50 customers → 400 BULK_SELECTION_TOO_LARGE before any render; 0 → 400 BULK_SELECTION_EMPTY', async () => {
    const b = await branch('BulkEdoCap');
    await prisma.customer.createMany({
      data: Array.from({ length: 51 }, (_, i) => ({
        tenantId: b.tenantId,
        firstName: `Cliente ${String(i).padStart(2, '0')}`,
      })),
    });

    const res = await bulk(b, {
      selection: { mode: 'filter', filter: {} },
      from: FROM,
      to: TO,
    }).expect(400);
    expect(res.body).toEqual({
      statusCode: 400,
      code: 'BULK_SELECTION_TOO_LARGE',
      message: 'selection resolves to 51 customers; max 50',
      field: 'selection',
      details: { count: 51, max: 50 },
    });

    const empty = await bulk(b, {
      selection: { mode: 'filter', filter: { search: 'nadie-coincide' } },
      from: FROM,
      to: TO,
    }).expect(400);
    expect(empty.body.code).toBe('BULK_SELECTION_EMPTY');
    expect(renderMs).toHaveLength(0);
  });

  it('exactly 50 customers → 200 with 50 entries', async () => {
    const b = await branch('BulkEdo50');
    await prisma.customer.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        tenantId: b.tenantId,
        firstName: `Cliente ${String(i).padStart(2, '0')}`,
      })),
    });
    const res = await bulkZip(b, {
      selection: { mode: 'filter', filter: {} },
      from: FROM,
      to: TO,
    }).expect(200);
    const entries = readZip(res.body as Buffer);
    expect(entries).toHaveLength(50);
    expect(entries[0].name).toBe('Cliente 00.pdf');
    expect(entries[49].name).toBe('Cliente 49.pdf');
    const sorted = [...renderMs].sort((x, y) => x - y);
    console.log(
      JSON.stringify({
        gate: 'bulk-statements-50-empty',
        note: 'Jest maps yoga-layout to a stub: layout cost is not production cost',
        renders: renderMs.length,
        p50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)]),
        p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
        maxMs: Math.round(sorted[sorted.length - 1]),
        zipBytes: (res.body as Buffer).length,
      }),
    );
  });

  it('period validation: the single statement rules (400)', async () => {
    const b = await branch('BulkEdoQ');
    const id = await customer(b, 'Ana');
    for (const period of [
      { from: FROM },
      { from: FROM, to: FROM },
      { from: '2026-03-02', to: '2026-03-01' },
      { from: '2025-01-01', to: '2026-01-03' },
      { from: '2026-02-30', to: '2026-03-05' },
    ]) {
      await bulk(b, {
        selection: { mode: 'ids', customerIds: [id] },
        ...period,
      }).expect(400);
    }
    expect(renderMs).toHaveLength(0);
  });

  it('permissions: without read:Sale → 403; without read:Customer → 403', async () => {
    const noSale = await branch('BulkEdoSinVentas', ['Customer:read']);
    const noCustomer = await branch('BulkEdoSinClientes', ['Sale:read']);
    const payload = (id: string) => ({
      selection: { mode: 'ids', customerIds: [id] },
      from: FROM,
      to: TO,
    });
    const forbidden = {
      statusCode: 403,
      error: 'INSUFFICIENT_PERMISSIONS',
      message: 'Insufficient permissions',
      timestamp: expect.any(String) as unknown,
    };
    const r1 = await bulk(
      noSale,
      payload(await customer(noSale, 'Ana')),
    ).expect(403);
    expect(r1.body).toEqual(forbidden);
    expect(r1.headers['content-disposition']).toBeUndefined();
    const r2 = await bulk(
      noCustomer,
      payload(await customer(noCustomer, 'Ana')),
    ).expect(403);
    expect(r2.body).toEqual(forbidden);
    expect(r2.headers['content-disposition']).toBeUndefined();
    expect(renderMs).toHaveLength(0);
  });

  it('a second request while one runs → 429 BULK_EXPORT_BUSY with Retry-After; the first completes and the slot is free again', async () => {
    const b = await branch('BulkEdoBusy');
    const id = await customer(b, 'Ana');
    const payload = {
      selection: { mode: 'ids', customerIds: [id] },
      from: FROM,
      to: TO,
    };
    gate = new Promise<void>((resolve) => (releaseGate = resolve));
    const started = new Promise<void>((resolve) => (renderStarted = resolve));

    const first = bulkZip(b, payload).then((res) => res);
    try {
      await started;

      const busy = await bulk(b, payload).expect(429);
      expect(busy.headers['retry-after']).toBe('10');
      expect(busy.body).toEqual({
        statusCode: 429,
        code: 'BULK_EXPORT_BUSY',
        message: 'another bulk statements download is in progress; retry later',
        details: { retryAfterSeconds: 10 },
      });
    } finally {
      // A failing assertion must not leave the first run (and the suite) hanging.
      releaseGate?.();
    }
    expect((await first).status).toBe(200);

    gate = null;
    renderStarted = null;
    await bulkZip(b, payload).expect(200);
  });

  it('the slot is released after an error (404), the next run succeeds', async () => {
    const b = await branch('BulkEdoRelease');
    const id = await customer(b, 'Ana');
    await bulk(b, {
      selection: { mode: 'ids', customerIds: [randomUUID()] },
      from: FROM,
      to: TO,
    }).expect(404);
    await bulkZip(b, {
      selection: { mode: 'ids', customerIds: [id] },
      from: FROM,
      to: TO,
    }).expect(200);
  });

  it('the single statement route is unchanged: PDF attachment, fixed filename, 404 for a foreign customer', async () => {
    const b = await branch('BulkEdoSingle');
    const other = await branch('BulkEdoSingleB');
    const id = await customer(b, 'Ana');
    const foreign = await customer(other, 'Ajena');

    const res = await single(b, id).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="estado-de-cuenta-${id}-${FROM}-${TO}.pdf"`,
    );
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const notFound = await request(server())
      .get(`/customers/${foreign}/statement/pdf?from=${FROM}&to=${TO}`)
      .set(auth(b.member))
      .expect(404);
    expect(notFound.body).toEqual({
      statusCode: 404,
      error: 'CUSTOMER_NOT_FOUND',
      message: 'CUSTOMER_NOT_FOUND',
    });
  });
});
