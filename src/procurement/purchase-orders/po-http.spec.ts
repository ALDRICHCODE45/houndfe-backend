/* eslint-disable @typescript-eslint/require-await -- Async authorization double. */
import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { createMongoAbility } from '@casl/ability';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { Server } from 'node:http';
import request from 'supertest';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrderCommands } from './po-commands';
import { PurchaseOrderQueries } from './po-queries';
import { installPurchaseOrderBodyParser } from './po-body-parser';
import { PurchaseOrderContractError } from './po-contract';
import { SuppliersController } from '../suppliers/suppliers.controller';
import { SupplierCommands } from '../suppliers/supplier-commands';
import { SupplierQueries } from '../suppliers/supplier-queries';
import { installSupplierBodyParser } from '../suppliers/supplier-http.filter';
import { JwtStrategy } from '../../auth/infrastructure/strategies/jwt.strategy';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { editorialCors } from '../../catalog-editorial/http/editorial-cors';

const base = '/procurement/purchase-orders';
const id = '10000000-0000-4000-8000-000000000001';
const input = {
  supplierId: null,
  note: null,
  location: { detail: null },
  lines: [],
};
const order = { ...input, id, version: 1, status: 'DRAFT' };
const replace = { expectedVersion: 1, order: input };
const confirmBody = {
  expectedVersion: 1,
  expectedSupplierVersion: 3,
  expectedReferenceToken: 'prt1.opaque',
};
const cancelBody = { expectedVersion: 1 };
const key = 'Opaque,Key';

@Controller('unrelated-parser-proof')
class DefaultParserController {
  @Post()
  body(@Body() body: unknown) {
    return body;
  }
}

describe('PO HTTP boundary (offline; real JWT/CLS/permission guards)', () => {
  let app: INestApplication;
  let token: string;
  let cls: ClsService;
  let permissions: Array<{ action: string; subject: string }>;
  const commands = {
    createDraft: jest.fn(),
    replaceDraft: jest.fn(),
    deleteDraft: jest.fn(),
    confirm: jest.fn(),
    cancel: jest.fn(),
  };
  const queries = { getDraft: jest.fn(), listDrafts: jest.fn() };
  const supplierCommands = { create: jest.fn(), delete: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      ],
      controllers: [
        PurchaseOrdersController,
        SuppliersController,
        DefaultParserController,
      ],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        TenantContextGuard,
        PermissionsGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: 'offline-only' }),
        },
        { provide: PurchaseOrderCommands, useValue: commands },
        { provide: PurchaseOrderQueries, useValue: queries },
        { provide: SupplierCommands, useValue: supplierCommands },
        { provide: SupplierQueries, useValue: {} },
        {
          provide: CaslAbilityFactory,
          useValue: {
            createForUser: async () => createMongoAbility(permissions),
          },
        },
      ],
    }).compile();
    cls = module.get(ClsService);
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(createAppValidationPipe());
    app.enableCors(editorialCors({ origin: 'https://offline.example' }));
    installSupplierBodyParser(app);
    installPurchaseOrderBodyParser(app);
    await app.init();
    token = new JwtService({ secret: 'offline-only' }).sign({
      sub: 'actor',
      email: 'offline@example.invalid',
      tenantId: 'tenant-a',
      tenantSlug: 'a',
      isSuperAdmin: false,
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    permissions = ['read', 'create', 'update', 'delete'].map((action) => ({
      action,
      subject: 'ProcurementPurchaseOrder',
    }));
    permissions.push(
      { action: 'read', subject: 'Product' },
      { action: 'read', subject: 'ProcurementSupplier' },
      { action: 'create', subject: 'ProcurementSupplier' },
      { action: 'delete', subject: 'ProcurementSupplier' },
    );
    commands.createDraft.mockResolvedValue({ statusCode: 201, body: order });
    commands.replaceDraft.mockResolvedValue({ statusCode: 200, body: order });
    commands.deleteDraft.mockResolvedValue({ statusCode: 204, body: null });
    commands.confirm.mockResolvedValue({
      statusCode: 200,
      body: { ...order, status: 'CONFIRMED' },
    });
    commands.cancel.mockResolvedValue({
      statusCode: 200,
      body: { ...order, status: 'CANCELLED' },
    });
    queries.getDraft.mockResolvedValue(order);
    queries.listDrafts.mockResolvedValue({ items: [], nextCursor: null });
    supplierCommands.create.mockResolvedValue({ statusCode: 201, body: {} });
    supplierCommands.delete.mockResolvedValue({ statusCode: 204, body: null });
  });
  function http(
    method: 'get' | 'post' | 'put' | 'delete',
    path = base,
    auth = true,
  ) {
    const call = request(app.getHttpServer() as Server)
      [method](path)
      .set('Origin', 'https://offline.example');
    return auth ? call.set('Authorization', `Bearer ${token}`) : call;
  }
  function closed(response: request.Response, status: number, error: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ statusCode: status, error });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://offline.example',
    );
  }
  function noCalls() {
    for (const fn of [...Object.values(commands), ...Object.values(queries)])
      expect(fn).not.toHaveBeenCalled();
  }
  function writePath(method: string): string {
    return method === 'post'
      ? base
      : method === 'put'
        ? `${base}/${id}/draft`
        : `${base}/${id}`;
  }
  function writeBody(method: string) {
    return method === 'post'
      ? input
      : method === 'put'
        ? replace
        : { expectedVersion: 1 };
  }
  it('forwards routes, raw query and exact acknowledgements; DELETE has zero bytes', async () => {
    expect((await http('get', `${base}?limit=1`)).body).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(queries.listDrafts).toHaveBeenCalledWith({ limit: '1' });
    expect((await http('get', `${base}/${id}`)).body).toEqual(order);
    expect(queries.getDraft).toHaveBeenCalledWith(id);
    commands.createDraft.mockImplementationOnce(() => {
      expect(cls.get('userId')).toBe('actor');
      expect(cls.get('tenantId')).toBe('tenant-a');
      return Promise.resolve({ statusCode: 201, body: order });
    });
    const created = await http('post').set('Idempotency-Key', key).send(input);
    expect(created.status).toBe(201);
    expect(created.body).toEqual(order);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(commands.createDraft).toHaveBeenCalledWith(key, input);
    const updated = await http('put', `${base}/${id}/draft`)
      .set('Idempotency-Key', key)
      .send(replace);
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual(order);
    expect(commands.replaceDraft).toHaveBeenCalledWith(id, key, replace);
    const deleted = await http('delete', `${base}/${id}`)
      .set('Idempotency-Key', key)
      .send({ expectedVersion: 1 });
    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe('');
    expect(deleted.headers['content-type']).toBeUndefined();
    expect(deleted.headers['cache-control']).toBe('no-store');
    expect(commands.deleteDraft).toHaveBeenCalledWith(id, key, {
      expectedVersion: 1,
    });
  });
  it.each(['get', 'post', 'put', 'delete'] as const)(
    'denies anonymous %s with closed no-store envelope',
    async (method) => {
      closed(
        await http(method, method === 'get' ? base : writePath(method), false)
          .set('Idempotency-Key', key)
          .send(method === 'get' ? undefined : writeBody(method)),
        401,
        'UNAUTHORIZED',
      );
      noCalls();
    },
  );
  it.each([
    ['post', 'create', 'ProcurementPurchaseOrder'],
    ['post', 'read', 'Product'],
    ['post', 'read', 'ProcurementSupplier'],
    ['put', 'update', 'ProcurementPurchaseOrder'],
    ['put', 'read', 'ProcurementPurchaseOrder'],
    ['put', 'read', 'Product'],
    ['put', 'read', 'ProcurementSupplier'],
    ['delete', 'read', 'ProcurementPurchaseOrder'],
    ['delete', 'delete', 'ProcurementPurchaseOrder'],
    ['get', 'read', 'ProcurementPurchaseOrder'],
  ] as const)('requires %s %s:%s', async (method, action, subject) => {
    permissions = permissions.filter(
      (grant) => grant.action !== action || grant.subject !== subject,
    );
    closed(
      await http(method, method === 'get' ? base : writePath(method))
        .set('Idempotency-Key', key)
        .send(method === 'get' ? undefined : writeBody(method)),
      403,
      'FORBIDDEN',
    );
    noCalls();
  });
  it('allows read PO alone; POST needs no read PO; DELETE needs no reference grants', async () => {
    permissions = [{ action: 'read', subject: 'ProcurementPurchaseOrder' }];
    expect((await http('get')).status).toBe(200);
    permissions = [
      { action: 'create', subject: 'ProcurementPurchaseOrder' },
      { action: 'read', subject: 'Product' },
      { action: 'read', subject: 'ProcurementSupplier' },
    ];
    expect(
      (await http('post').set('Idempotency-Key', key).send(input)).status,
    ).toBe(201);
    permissions = [
      { action: 'read', subject: 'ProcurementPurchaseOrder' },
      { action: 'delete', subject: 'ProcurementPurchaseOrder' },
    ];
    expect(
      (
        await http('delete', `${base}/${id}`)
          .set('Idempotency-Key', key)
          .send({ expectedVersion: 1 })
      ).status,
    ).toBe(204);
  });
  it.each(['post', 'put', 'delete'] as const)(
    'rejects malformed/primitive/oversized %s JSON before commands',
    async (method) => {
      for (const raw of [
        '{',
        'null',
        '1',
        'true',
        '[]',
        '{}',
        JSON.stringify({ private: 'x'.repeat(110000) }),
      ]) {
        closed(
          await http(method, writePath(method))
            .set('Idempotency-Key', key)
            .set('Content-Type', 'application/json')
            .send(raw),
          400,
          'MALFORMED',
        );
      }
      noCalls();
    },
  );
  it.each(['post', 'put', 'delete'] as const)(
    'requires JSON and one raw key on %s',
    async (method) => {
      const path = writePath(method);
      const body = writeBody(method);
      closed(await http(method, path).send(body), 400, 'MALFORMED');
      closed(
        await http(method, path)
          .set('Idempotency-Key', ['a', 'b'] as unknown as string)
          .send(body),
        400,
        'MALFORMED',
      );
      closed(
        await http(method, path)
          .set('Idempotency-Key', key)
          .set('Content-Type', 'text/plain')
          .send(JSON.stringify(body)),
        400,
        'MALFORMED',
      );
      noCalls();
    },
  );
  it.each([
    '{"expectedVersion":1,"expectedVersion":2}',
    '{"expectedVersion":1,"\\u0065xpectedVersion":1}',
  ])('rejects DELETE duplicate members %s', async (raw) => {
    closed(
      await http('delete', `${base}/${id}`)
        .set('Idempotency-Key', key)
        .set('Content-Type', 'application/json')
        .send(raw),
      400,
      'MALFORMED',
    );
    noCalls();
  });
  it('accepts one escaped DELETE key', async () => {
    expect(
      (
        await http('delete', `${base}/${id}`)
          .set('Idempotency-Key', key)
          .set('Content-Type', 'application/json')
          .send('{"\\u0065xpectedVersion":1}')
      ).status,
    ).toBe(204);
  });
  it.each([
    `${base}?limit=101`,
    `${base}?limit=1&limit=2`,
    `${base}?extra=1`,
    `${base}/bad`,
    `${base}/%E0%A4%A`,
    `${base}/${id}?x=1`,
  ])('rejects query/id %s', async (path) => {
    closed(await http('get', path), 400, 'MALFORMED');
    noCalls();
  });
  it('rejects GET body and write query/unknown field', async () => {
    closed(
      await http('get').set('Content-Type', 'text/plain').send('body'),
      400,
      'MALFORMED',
    );
    closed(
      await http('post', `${base}?x=1`).set('Idempotency-Key', key).send(input),
      400,
      'MALFORMED',
    );
    closed(
      await http('put', `${base}/${id}/draft`)
        .set('Idempotency-Key', key)
        .send({ ...replace, x: 1 }),
      400,
      'MALFORMED',
    );
    noCalls();
  });
  it.each([
    ['MALFORMED', 400],
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['ORDER_VERSION_CONFLICT', 409],
    ['SUPPLIER_ARCHIVED', 409],
    ['ORDER_NOT_READY', 409],
    ['ELIGIBILITY_CHANGED', 409],
    ['SUPPLIER_VERSION_CONFLICT', 409],
    ['ORDER_STATE_CONFLICT', 409],
    ['IDEMPOTENCY_KEY_CONFLICT', 409],
    ['IDEMPOTENCY_KEY_IN_FLIGHT', 409],
    ['INTERNAL_ERROR', 500],
  ] as const)('maps %s without retry or values', async (code, status) => {
    commands.replaceDraft.mockRejectedValueOnce(
      new PurchaseOrderContractError(code),
    );
    closed(
      await http('put', `${base}/${id}/draft`)
        .set('Idempotency-Key', key)
        .send(replace),
      status,
      code,
    );
    expect(commands.replaceDraft).toHaveBeenCalledTimes(1);
  });
  it('admits uncoerced server search and closes repeated/invalid terms', async () => {
    expect(
      (await http('get', `${base}?search=%20É%20%20note%25%20`)).status,
    ).toBe(200);
    expect(queries.listDrafts).toHaveBeenCalledWith({ search: ' É  note% ' });
    queries.listDrafts.mockClear();
    for (const query of [
      'search=a&search=b',
      `search=${encodeURIComponent('😀'.repeat(201))}`,
      'search=%00term',
    ])
      closed(await http('get', `${base}?${query}`), 400, 'MALFORMED');
    noCalls();
  });
  it('admits a single status filter and closes repeated/invalid values', async () => {
    expect((await http('get', `${base}?status=CONFIRMED`)).status).toBe(200);
    expect(queries.listDrafts).toHaveBeenCalledWith({ status: 'CONFIRMED' });
    queries.listDrafts.mockClear();
    for (const query of [
      'status=DRAFT&status=CANCELLED',
      'status=ALL',
      'status=draft',
      'status=',
      'state=DRAFT',
    ])
      closed(await http('get', `${base}?${query}`), 400, 'MALFORMED');
    noCalls();
  });
  it('sanitizes unexpected errors', async () => {
    queries.getDraft.mockRejectedValueOnce(
      new Error('private database details'),
    );
    closed(await http('get', `${base}/${id}`), 500, 'INTERNAL_ERROR');
  });
  it.each([
    ['post', '/PROCUREMENT/PURCHASE-ORDERS/'],
    ['put', `/Procurement/Purchase-Orders/${id}/draft/`],
    ['delete', `/procurement/purchase-orders/${id}/`],
  ] as const)('closes equivalent %s %s admission', async (method, path) => {
    closed(
      await http(method, path)
        .set('Content-Type', 'application/json')
        .send('{'),
      400,
      'MALFORMED',
    );
    noCalls();
  });
  it('preserves supplier and unrelated/default parsers with both parsers installed', async () => {
    const supplierPath = '/procurement/suppliers';
    closed(
      await http('delete', `${supplierPath}/${id}`)
        .set('Content-Type', 'application/json')
        .send('{'),
      400,
      'MALFORMED',
    );
    closed(
      await http('post', supplierPath)
        .set('Content-Type', 'application/json')
        .send('1'),
      400,
      'MALFORMED',
    );
    expect(
      (
        await http('post', supplierPath)
          .set('Idempotency-Key', key)
          .send({ displayName: 'Supplier', termsText: null, status: 'ACTIVE' })
      ).status,
    ).toBe(201);
    const plain = await http('post', '/unrelated-parser-proof').send({
      ok: true,
    });
    expect(plain.body).toEqual({ ok: true });
    for (const path of [
      '/unrelated-parser-proof',
      '/procurement/purchase-orders-extra',
      `${base}/${id}/history`,
    ]) {
      const result = await http('post', path)
        .set('Content-Type', 'application/json')
        .send('{');
      expect(result.status).toBe(400);
      expect(result.body).not.toEqual({ statusCode: 400, error: 'MALFORMED' });
      expect(result.headers['cache-control']).toBeUndefined();
    }
    noCalls();
  });
  it('has no history endpoint', async () => {
    expect((await http('post', `${base}/${id}/history`)).status).toBe(404);
    expect((await http('get', `${base}/${id}/history`)).status).toBe(404);
    noCalls();
  });
  describe.each([
    ['confirm', 'confirm', confirmBody, 'ProcurementOrderConfirmation'],
    ['cancel', 'cancel', cancelBody, 'ProcurementOrderCancellation'],
  ] as const)('POST /:orderId/%s', (name, command, body, subject) => {
    const path = `${base}/${id}/${name}`;
    beforeEach(() => {
      permissions = [
        { action: 'read', subject: 'ProcurementPurchaseOrder' },
        { action: 'create', subject },
      ];
    });
    it('answers 200 no-store with the command body, raw key and parsed id', async () => {
      commands[command].mockImplementationOnce(() => {
        expect(cls.get('userId')).toBe('actor');
        return Promise.resolve({ statusCode: 200, body: { ...order, name } });
      });
      const response = await http('post', path)
        .set('Idempotency-Key', key)
        .send(body);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ...order, name });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(commands[command]).toHaveBeenCalledWith(id, key, body);
    });
    it('needs only read PO + its own create subject (no edit/catalog grants)', async () => {
      expect(
        (await http('post', path).set('Idempotency-Key', key).send(body))
          .status,
      ).toBe(200);
    });
    it.each([
      ['read', 'ProcurementPurchaseOrder'],
      ['create', subject],
    ])('requires %s:%s', async (action, missing) => {
      permissions = permissions.filter(
        (grant) => grant.action !== action || grant.subject !== missing,
      );
      closed(
        await http('post', path).set('Idempotency-Key', key).send(body),
        403,
        'FORBIDDEN',
      );
      noCalls();
    });
    it('does not accept the other transition subject or PO update/delete', async () => {
      permissions = [
        { action: 'read', subject: 'ProcurementPurchaseOrder' },
        { action: 'update', subject: 'ProcurementPurchaseOrder' },
        { action: 'delete', subject: 'ProcurementPurchaseOrder' },
        {
          action: 'create',
          subject:
            subject === 'ProcurementOrderConfirmation'
              ? 'ProcurementOrderCancellation'
              : 'ProcurementOrderConfirmation',
        },
      ];
      closed(
        await http('post', path).set('Idempotency-Key', key).send(body),
        403,
        'FORBIDDEN',
      );
      noCalls();
    });
    it('denies anonymous callers with the closed envelope', async () => {
      closed(
        await http('post', path, false).set('Idempotency-Key', key).send(body),
        401,
        'UNAUTHORIZED',
      );
      noCalls();
    });
    it('requires JSON, one raw key, no query and a parseable body', async () => {
      closed(await http('post', path).send(body), 400, 'MALFORMED');
      closed(
        await http('post', path)
          .set('Idempotency-Key', ['a', 'b'] as unknown as string)
          .send(body),
        400,
        'MALFORMED',
      );
      closed(
        await http('post', path)
          .set('Idempotency-Key', key)
          .set('Content-Type', 'text/plain')
          .send(JSON.stringify(body)),
        400,
        'MALFORMED',
      );
      closed(
        await http('post', `${path}?x=1`)
          .set('Idempotency-Key', key)
          .send(body),
        400,
        'MALFORMED',
      );
      for (const raw of ['{', 'null', '1', '[]', '{}'])
        closed(
          await http('post', path)
            .set('Idempotency-Key', key)
            .set('Content-Type', 'application/json')
            .send(raw),
          400,
          'MALFORMED',
        );
      noCalls();
    });
    it('rejects unknown members and duplicate decoded member names before commands', async () => {
      closed(
        await http('post', path)
          .set('Idempotency-Key', key)
          .send({ ...body, reason: 'x' }),
        400,
        'MALFORMED',
      );
      closed(
        await http('post', path)
          .set('Idempotency-Key', key)
          .set('Content-Type', 'application/json')
          .send('{"expectedVersion":1,"\\u0065xpectedVersion":2}'),
        400,
        'MALFORMED',
      );
      noCalls();
    });
    it.each([
      ['ORDER_VERSION_CONFLICT', 409],
      ['ORDER_STATE_CONFLICT', 409],
      ['ORDER_NOT_READY', 409],
      ['SUPPLIER_VERSION_CONFLICT', 409],
      ['SUPPLIER_ARCHIVED', 409],
      ['ELIGIBILITY_CHANGED', 409],
      ['IDEMPOTENCY_KEY_CONFLICT', 409],
      ['IDEMPOTENCY_KEY_IN_FLIGHT', 409],
      ['NOT_FOUND', 404],
      ['FORBIDDEN', 403],
      ['INTERNAL_ERROR', 500],
    ] as const)('maps %s to the value-free envelope', async (code, status) => {
      commands[command].mockRejectedValueOnce(
        new PurchaseOrderContractError(code),
      );
      closed(
        await http('post', path).set('Idempotency-Key', key).send(body),
        status,
        code,
      );
      expect(commands[command]).toHaveBeenCalledTimes(1);
    });
    it('rejects an invalid order id before commands', async () => {
      closed(
        await http('post', `${base}/not-an-id/${name}`)
          .set('Idempotency-Key', key)
          .send(body),
        400,
        'MALFORMED',
      );
      closed(
        await http('post', `${base}/%E0%A4%A/${name}`)
          .set('Idempotency-Key', key)
          .send(body),
        400,
        'MALFORMED',
      );
      noCalls();
    });
  });
});
