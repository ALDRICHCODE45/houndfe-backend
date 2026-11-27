/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped JSON */
/**
 * customers-bulk-actions / T1 (S1, S2, S3) — `POST /customers/bulk/export`
 * against REAL PostgreSQL through the real JWT → tenant → CASL chain, the
 * production validation pipe and the app CORS config:
 *
 * - ids mode and filter mode (+ excludeIds) export exactly the customers the
 *   listing shows for the same filter, in the requested order;
 * - ids mode is strict: unknown / foreign-branch ids → 404 with missingIds;
 * - `export:Customer` is required (explicit row or `manage:all`;
 *   `manage:Customer` alone is not enough) → standard 403 otherwise;
 * - metric columns only with `read:Sale`; metric filters / sorts → 400;
 * - 10,000-row cap: 10,000 exported, 10,001 → 400 before any byte;
 * - `Content-Disposition` is exposed to the allowed cross-origin frontend;
 * - `GET /customers/listing` keeps its behavior (also covered by its own
 *   integration spec).
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../../auth/infrastructure/strategies/jwt.strategy';
import { appCors } from '../../catalog-editorial/http/editorial-cors';
import {
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  TEST_JWT_SECRET,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../../delivery-zones/test-support/delivery-zone-world';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { CustomersListingController } from '../listing/customers-listing.controller';
import { CustomersListingService } from '../listing/customers-listing.service';
import { PrismaCustomersListingReader } from '../listing/prisma-customers-listing.reader';
import { PrismaCustomerBulkSelectionReader } from './customer-bulk-selection.reader';
import { CustomerBulkSelectionResolver } from './customer-bulk-selection.resolver';
import { CustomersBulkExportService } from './customers-bulk-export.service';
import { CustomersBulkController } from './customers-bulk.controller';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

/** 23:59 local on 26/11 (Mexico City, UTC-6) → local today 26/11. */
const NOW = new Date('2026-11-27T05:59:00.000Z');
const ORIGIN = 'https://allowed.test';
const BOM = '\uFEFF';

const config = {
  get: (key: string) =>
    key === 'PROMOTIONS_BUSINESS_TIMEZONE' ? 'America/Mexico_City' : undefined,
} as unknown as ConfigService;

const binary = (
  res: NodeJS.ReadableStream,
  callback: (error: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describeIfDb('POST /customers/bulk/export (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
      ],
      controllers: [CustomersListingController, CustomersBulkController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        TenantContextGuard,
        PermissionsGuard,
        CaslAbilityFactory,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => TEST_JWT_SECRET,
            get: () => TEST_JWT_SECRET,
          },
        },
        {
          provide: CustomersListingService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) =>
            new CustomersListingService(
              new PrismaCustomersListingReader(tenantPrisma),
              config,
              () => NOW,
            ),
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
        {
          provide: CustomersBulkExportService,
          inject: [CustomerBulkSelectionResolver],
          useFactory: (resolver: CustomerBulkSelectionResolver) =>
            new CustomersBulkExportService(resolver, config, () => NOW),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // main.ts order: CORS (configured-origins branch) before init.
    app.enableCors(appCors({ origin: [ORIGIN], credentials: true }));
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    await app.init();
  });

  afterEach(async () => {
    await world.cleanup();
  });

  afterAll(async () => {
    await app?.close();
    await disconnectWorldPrisma();
  });

  // ─────────────────────────────── fixtures ───────────────────────────────

  interface Branch {
    tenantId: string;
    /** read:Customer + read:Sale + export:Customer */
    exporter: SeededMember;
    /** read:Customer + export:Customer (no read:Sale) */
    exporterNoSale: SeededMember;
  }

  async function branch(name: string): Promise<Branch> {
    const tenantId = await world.tenant(name);
    const exporter = await world.member(tenantId, `Gerente ${name}`, [
      'Customer:read',
      'Sale:read',
      'Customer:export',
    ]);
    const exporterNoSale = await world.member(tenantId, `Vendedor ${name}`, [
      'Customer:read',
      'Customer:export',
    ]);
    return { tenantId, exporter, exporterNoSale };
  }

  let seq = 0;
  async function customer(
    b: Branch,
    firstName: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const id = randomUUID();
    await prisma.customer.create({
      data: {
        id,
        tenantId: b.tenantId,
        firstName,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)),
        ...over,
      },
    });
    return id;
  }

  async function debtSale(b: Branch, customerId: string, debtCents: number) {
    const id = randomUUID();
    await prisma.sale.create({
      data: {
        id,
        tenantId: b.tenantId,
        userId: b.exporter.userId,
        customerId,
        status: 'CONFIRMED',
        channel: 'POS',
        folio: `B-${++seq}-${id.slice(0, 6)}`,
        confirmedAt: new Date('2026-11-20T19:31:02.000Z'),
        subtotalCents: debtCents + 1000,
        totalCents: debtCents + 1000,
        paidCents: 1000,
        debtCents,
        paymentStatus: 'CREDIT',
        deliveryStatus: 'DELIVERED',
      },
    });
  }

  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  const exportCsv = (m: SeededMember, body: unknown) =>
    request(server())
      .post('/customers/bulk/export')
      .set(auth(m))
      .set('Origin', ORIGIN)
      .send(body as object)
      .buffer(true)
      .parse(binary as unknown as Parameters<request.Test['parse']>[0]);
  /** Records of a CSV body (BOM stripped). Fixture data has no quoted CRLF. */
  const records = (res: request.Response) => {
    const text = (res.body as Buffer).toString('utf8');
    expect(text.startsWith(BOM)).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    return text
      .slice(1, -2)
      .split('\r\n')
      .map((line) => line.split(','));
  };
  const idsOf = (res: request.Response) =>
    records(res)
      .slice(1)
      .map((cells) => cells[0]);

  // ───────────────────────────── ids mode ─────────────────────────────

  describe('ids mode', () => {
    it('exports exactly the selected customers with metrics, in the requested order, as CSV', async () => {
      const b = await branch('Ids');
      const ana = await customer(b, 'Ana', {
        lastName: 'López',
        phone: '5512345678',
      });
      const beto = await customer(b, 'Beto');
      await customer(b, 'Carla'); // not selected
      await debtSale(b, ana, 78500);
      await prisma.customerAddress.create({
        data: {
          tenantId: b.tenantId,
          customerId: ana,
          street: 'Calle 1',
          neighborhood: 'Del Valle',
          zipCode: '03100',
        },
      });

      const res = await exportCsv(b.exporter, {
        selection: { mode: 'ids', customerIds: [beto, ana, beto] },
        sortBy: 'name',
        sortOrder: 'asc',
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="clientes-2026-11-26.csv"',
      );
      expect(res.headers['cache-control']).toBe('no-store');
      // S3: the cross-origin frontend can read the filename.
      expect(res.headers['access-control-expose-headers']).toBe(
        'Content-Disposition',
      );
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);

      const [header, first, second, ...rest] = records(res);
      expect(rest).toEqual([]);
      expect(header).toHaveLength(28);
      expect(header.slice(-8)).toEqual([
        'Deuda',
        'Deuda vencida',
        'Ventas vencidas',
        'Vencido desde',
        'Compras',
        'Total comprado',
        'Ticket promedio',
        'Última compra',
      ]);
      expect(first[0]).toBe(ana);
      expect(first.slice(1, 3)).toEqual(['Ana', 'López']);
      expect(first[5]).toBe('5512345678');
      expect(first[13]).toBe('Del Valle');
      expect(first[17]).toBe('"=""03100"""');
      expect(first.slice(20)).toEqual([
        '785.00',
        '0.00',
        '0',
        '',
        '1',
        '795.00',
        '795.00',
        '2026-11-20 13:31',
      ]);
      expect(second[0]).toBe(beto);
      expect(second.slice(20)).toEqual([
        '0.00',
        '0.00',
        '0',
        '',
        '0',
        '0.00',
        '',
        '',
      ]);
    });

    it('strict: unknown and foreign-branch ids → 404 BULK_CUSTOMERS_NOT_FOUND with missingIds; nothing exported', async () => {
      const b = await branch('Estricto');
      const other = await branch('Ajena');
      const mine = await customer(b, 'Mía');
      const foreign = await customer(other, 'Ajena');
      const unknown = randomUUID();

      const res = await request(server())
        .post('/customers/bulk/export')
        .set(auth(b.exporter))
        .send({
          selection: { mode: 'ids', customerIds: [mine, foreign, unknown] },
        });
      expect(res.status).toBe(404);
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.body).toEqual({
        statusCode: 404,
        code: 'BULK_CUSTOMERS_NOT_FOUND',
        message: '2 customers not found',
        field: 'customerIds',
        details: { missingIds: [foreign, unknown] },
      });
    });
  });

  // ──────────────────────────── filter mode ────────────────────────────

  describe('filter mode', () => {
    it('exports every customer the listing shows for the same filter, minus excludeIds, tenant-isolated', async () => {
      const b = await branch('Filtro');
      const other = await branch('OtraSucursal');
      const deudor1 = await customer(b, 'Deudor Uno');
      const deudor2 = await customer(b, 'Deudor Dos');
      const deudor3 = await customer(b, 'Deudor Tres');
      await customer(b, 'Al corriente');
      const foreign = await customer(other, 'Deudor Ajeno');
      await debtSale(b, deudor1, 100);
      await debtSale(b, deudor2, 300);
      await debtSale(b, deudor3, 200);
      await debtSale(other, foreign, 999);

      const listing = await request(server())
        .get('/customers/listing')
        .query({ hasDebt: 'true', sortBy: 'openDebt', sortOrder: 'desc' })
        .set(auth(b.exporter));
      expect(listing.status).toBe(200);
      const listed = (listing.body.data as Array<{ id: string }>).map(
        (r) => r.id,
      );
      expect(listed).toEqual([deudor2, deudor3, deudor1]);

      const all = await exportCsv(b.exporter, {
        selection: { mode: 'filter', filter: { hasDebt: 'true' } },
        sortBy: 'openDebt',
        sortOrder: 'desc',
      });
      expect(all.status).toBe(200);
      expect(idsOf(all)).toEqual(listed);

      const minus = await exportCsv(b.exporter, {
        selection: {
          mode: 'filter',
          filter: { hasDebt: 'true' },
          // A foreign id and an id outside the filter are ignored.
          excludeIds: [deudor3, foreign, randomUUID()],
        },
        sortBy: 'openDebt',
        sortOrder: 'desc',
      });
      expect(minus.status).toBe(200);
      expect(idsOf(minus)).toEqual([deudor2, deudor1]);
    });

    it('a filter matching nothing → 200 with the header row only', async () => {
      const b = await branch('Vacio');
      await customer(b, 'Ana');
      const res = await exportCsv(b.exporter, {
        selection: { mode: 'filter', filter: { search: 'zzz-nadie' } },
      });
      expect(res.status).toBe(200);
      expect(records(res)).toHaveLength(1);
    });

    it('filter values are validated with the listing rules and codes (plain param names)', async () => {
      const b = await branch('Validacion');
      const bad = await request(server())
        .post('/customers/bulk/export')
        .set(auth(b.exporter))
        .send({ selection: { mode: 'filter', filter: { openDebtMin: '-1' } } });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({
        code: 'LISTING_INVALID_NUMBER',
        field: 'openDebtMin',
      });

      const page = await request(server())
        .post('/customers/bulk/export')
        .set(auth(b.exporter))
        .send({ selection: { mode: 'filter', filter: { page: '2' } } });
      expect(page.status).toBe(400);
      expect(page.body.message[0].property).toBe('page');

      const shape = await request(server())
        .post('/customers/bulk/export')
        .set(auth(b.exporter))
        .send({ selection: { mode: 'ids', customerIds: ['nope'] } });
      expect(shape.status).toBe(400);
    });
  });

  // ──────────────────────────── permissions ────────────────────────────

  describe('permissions', () => {
    it('without export:Customer → standard 403 INSUFFICIENT_PERMISSIONS (manage:Customer is not enough)', async () => {
      const b = await branch('Permisos');
      const id = await customer(b, 'Ana');
      const body = { selection: { mode: 'ids', customerIds: [id] } };
      for (const grants of [
        ['Customer:read', 'Sale:read'],
        ['Customer:manage', 'Sale:read'],
        ['Customer:export'], // export without read:Customer
      ]) {
        const m = await world.member(
          b.tenantId,
          `Sin export ${grants.join()}`,
          grants,
        );
        const res = await request(server())
          .post('/customers/bulk/export')
          .set(auth(m))
          .send(body);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
        expect(res.headers['content-disposition']).toBeUndefined();
      }
    });

    it('manage:all (Super Admin) exports, with metrics', async () => {
      const b = await branch('SuperAdmin');
      const id = await customer(b, 'Ana');
      const admin = await world.member(b.tenantId, 'Admin', ['all:manage']);
      const res = await exportCsv(admin, {
        selection: { mode: 'ids', customerIds: [id] },
      });
      expect(res.status).toBe(200);
      expect(records(res)[0]).toHaveLength(28);
    });

    it('without read:Sale: 20 columns, no metrics; metric filter or sort → 400 LISTING_PARAM_REQUIRES_PERMISSION', async () => {
      const b = await branch('SinVentas');
      const id = await customer(b, 'Ana');
      await debtSale(b, id, 500);

      const ok = await exportCsv(b.exporterNoSale, {
        selection: { mode: 'ids', customerIds: [id] },
      });
      expect(ok.status).toBe(200);
      const [header, line] = records(ok);
      expect(header).toHaveLength(20);
      expect(header).not.toContain('Deuda');
      expect(line).toHaveLength(20);

      const metricFilter = await request(server())
        .post('/customers/bulk/export')
        .set(auth(b.exporterNoSale))
        .send({ selection: { mode: 'filter', filter: { hasDebt: 'true' } } });
      expect(metricFilter.status).toBe(400);
      expect(metricFilter.body).toEqual({
        statusCode: 400,
        code: 'LISTING_PARAM_REQUIRES_PERMISSION',
        message: 'hasDebt requires read:Sale',
        field: 'hasDebt',
        details: { required: 'read:Sale' },
      });

      const metricSort = await request(server())
        .post('/customers/bulk/export')
        .set(auth(b.exporterNoSale))
        .send({
          selection: { mode: 'ids', customerIds: [id] },
          sortBy: 'openDebt',
        });
      expect(metricSort.status).toBe(400);
      expect(metricSort.body).toMatchObject({
        code: 'LISTING_PARAM_REQUIRES_PERMISSION',
        field: 'sortBy',
      });
    });
  });

  // ──────────────────────────────── cap ────────────────────────────────

  describe('10,000-row cap (owner L2.1)', () => {
    it('10,000 rows export; 10,001 → 400 BULK_SELECTION_TOO_LARGE before any byte', async () => {
      const b = await branch('Tope');
      const base = Date.UTC(2025, 0, 1);
      await prisma.customer.createMany({
        data: Array.from({ length: 10_000 }, (_, i) => ({
          id: randomUUID(),
          tenantId: b.tenantId,
          firstName: `Cliente ${i}`,
          createdAt: new Date(base + i * 1000),
        })),
      });

      const startedAt = Date.now();
      const full = await exportCsv(b.exporter, {
        selection: { mode: 'filter', filter: {} },
      });
      const elapsedMs = Date.now() - startedAt;
      expect(full.status).toBe(200);
      expect(records(full)).toHaveLength(10_001);
      // Measurement for the contract (§4.5): printed, not asserted tightly.
      console.log(
        `[customers-bulk-export] 10,000 rows with metrics: ${elapsedMs} ms, ${(full.body as Buffer).length} bytes`,
      );

      await customer(b, 'Uno más');
      const over = await request(server())
        .post('/customers/bulk/export')
        .set(auth(b.exporter))
        .send({ selection: { mode: 'filter', filter: {} } });
      expect(over.status).toBe(400);
      expect(over.headers['content-disposition']).toBeUndefined();
      expect(over.body).toEqual({
        statusCode: 400,
        code: 'BULK_SELECTION_TOO_LARGE',
        message: 'selection resolves to 10001 customers; max 10000',
        field: 'selection',
        details: { count: 10001, max: 10000 },
      });

      // excludeIds brings it back under the cap.
      const last = await prisma.customer.findFirst({
        where: { tenantId: b.tenantId, firstName: 'Uno más' },
        select: { id: true },
      });
      const under = await exportCsv(b.exporter, {
        selection: { mode: 'filter', filter: {}, excludeIds: [last!.id] },
      });
      expect(under.status).toBe(200);
      expect(records(under)).toHaveLength(10_001);
    }, 120_000);
  });

  // ───────────────────────────── listing ─────────────────────────────

  it('GET /customers/listing is unchanged: same page, totals and no bulk side effects', async () => {
    const b = await branch('Listado');
    const a = await customer(b, 'Ana');
    const c = await customer(b, 'Carla');
    const res = await request(server())
      .get('/customers/listing')
      .query({ sortBy: 'name', sortOrder: 'asc' })
      .set(auth(b.exporter));
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([a, c]);
    expect(res.body.pagination).toEqual({
      page: 1,
      limit: 50,
      total: 2,
      totalPages: 1,
    });
    // An unknown param is still a 400 there (no bulk keys leak into it).
    const leak = await request(server())
      .get('/customers/listing')
      .query({ excludeIds: a })
      .set(auth(b.exporter));
    expect(leak.status).toBe(400);
  });
});
