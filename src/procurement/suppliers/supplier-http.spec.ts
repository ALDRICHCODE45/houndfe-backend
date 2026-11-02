/* eslint-disable @typescript-eslint/require-await -- Async authorization double. */
import { Controller, Post, Body, type INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { createMongoAbility } from '@casl/ability';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { SuppliersController } from './suppliers.controller';
import { SupplierCommands } from './supplier-commands';
import { SupplierQueries } from './supplier-queries';
import { installSupplierBodyParser } from './supplier-http.filter';
import { SupplierContractError } from './supplier-contract';
import { JwtStrategy } from '../../auth/infrastructure/strategies/jwt.strategy';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { editorialCors } from '../../catalog-editorial/http/editorial-cors';

const id = '10000000-0000-4000-8000-000000000001';
const input = {
  displayName: ' Supplier 😀 ',
  termsText: null,
  status: 'ACTIVE',
};
const supplier = {
  ...input,
  id,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const update = { expectedVersion: 1, changes: { status: 'ARCHIVED' } };
const key = 'Opaque,Key';

@Controller('unrelated-parser-proof')
class DefaultParserController {
  @Post()
  body(@Body() body: unknown) {
    return body;
  }
}

describe('supplier public HTTP boundary (offline mocks; actual JWT/CLS/RBAC guards)', () => {
  let app: INestApplication;
  let token: string;
  let cls: ClsService;
  let permissions: string[];
  const commands = { create: jest.fn(), update: jest.fn() };
  const queries = { list: jest.fn(), detail: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      ],
      controllers: [SuppliersController, DefaultParserController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        TenantContextGuard,
        PermissionsGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: 'offline-only' }),
        },
        { provide: SupplierCommands, useValue: commands },
        { provide: SupplierQueries, useValue: queries },
        {
          provide: CaslAbilityFactory,
          useValue: {
            createForUser: async () =>
              createMongoAbility(
                permissions.map((action) => ({
                  action,
                  subject: 'ProcurementSupplier',
                })),
              ),
          },
        },
      ],
    }).compile();
    cls = module.get(ClsService);
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    app.enableCors(editorialCors({ origin: 'https://offline.example' }));
    installSupplierBodyParser(app);
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
    permissions = ['read', 'create', 'update'];
    commands.create.mockResolvedValue({ statusCode: 201, body: supplier });
    commands.update.mockResolvedValue({ statusCode: 200, body: supplier });
    queries.list.mockResolvedValue({ items: [supplier], nextCursor: null });
    queries.detail.mockResolvedValue(supplier);
  });
  function http(
    method: 'get' | 'post' | 'patch',
    path = '/procurement/suppliers',
    authenticated = true,
  ) {
    const call = request(app.getHttpServer() as Server)
      [method](path)
      .set('Origin', 'https://offline.example');
    return authenticated ? call.set('Authorization', `Bearer ${token}`) : call;
  }
  it.each(['expired', 'bad-signature', 'no-tenant'] as const)(
    'denies %s token without calling feature boundaries',
    async (kind) => {
      const claims = {
        sub: 'actor',
        email: 'offline@example.invalid',
        tenantId: kind === 'no-tenant' ? null : 'tenant-a',
        tenantSlug: 'a',
        isSuperAdmin: false,
      };
      const jwt = new JwtService({
        secret: kind === 'bad-signature' ? 'wrong' : 'offline-only',
      });
      const invalid = jwt.sign(
        claims,
        kind === 'expired' ? { expiresIn: -1 } : {},
      );
      closed(
        await http('get', '/procurement/suppliers?status=ALL', false).set(
          'Authorization',
          `Bearer ${invalid}`,
        ),
        401,
        'UNAUTHORIZED',
      );
      noCalls();
    },
  );
  function noCalls() {
    for (const call of [...Object.values(commands), ...Object.values(queries)])
      expect(call).not.toHaveBeenCalled();
  }
  function closed(response: request.Response, status: number, error: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ statusCode: status, error });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://offline.example',
    );
  }
  it('preserves the normal CORS preflight policy for supplier authorization/idempotency headers', async () => {
    const response = await request(app.getHttpServer() as Server)
      .options('/procurement/suppliers')
      .set('Origin', 'https://offline.example')
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'authorization,content-type,idempotency-key',
      );
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://offline.example',
    );
    expect(response.headers['access-control-allow-headers']).toBe(
      'authorization,content-type,idempotency-key',
    );
    noCalls();
  });
  it('lists the exact page without totals and forwards uncoerced query', async () => {
    const response = await http(
      'get',
      '/procurement/suppliers?status=ALL&search=%20É%25%20&limit=1',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [supplier], nextCursor: null });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(queries.list).toHaveBeenCalledWith({
      status: 'ALL',
      search: ' É% ',
      limit: '1',
    });
    expect(commands.create).not.toHaveBeenCalled();
  });
  it('reads tenant detail and creates with create-only permission', async () => {
    expect((await http('get', `/procurement/suppliers/${id}`)).body).toEqual(
      supplier,
    );
    permissions = ['create'];
    const response = await http('post').set('Idempotency-Key', key).send(input);
    expect(response.status).toBe(201);
    expect(response.body).toEqual(supplier);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(commands.create).toHaveBeenCalledTimes(1);
    expect(commands.create).toHaveBeenCalledWith(key, input);
  });
  it('seeds trusted authenticated CLS and routes case/trailing-slash equivalents normally', async () => {
    commands.create.mockImplementationOnce(() => {
      expect(cls.get<string>('userId')).toBe('actor');
      expect(cls.get<string>('tenantId')).toBe('tenant-a');
      return Promise.resolve({ statusCode: 201, body: supplier });
    });
    expect(
      (
        await http('post', '/PROCUREMENT/SUPPLIERS/')
          .set('Idempotency-Key', key)
          .send(input)
      ).status,
    ).toBe(201);
    expect(
      (await http('get', '/Procurement/Suppliers/?status=ALL')).status,
    ).toBe(200);
    expect(
      (
        await http('patch', `/Procurement/Suppliers/${id}/`)
          .set('Idempotency-Key', key)
          .send(update)
      ).status,
    ).toBe(200);
  });
  it('updates with read+update and returns original command acknowledgment without retry', async () => {
    const response = await http('patch', `/procurement/suppliers/${id}`)
      .set('Idempotency-Key', key)
      .send(update);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(supplier);
    expect(commands.update).toHaveBeenCalledTimes(1);
    expect(commands.update).toHaveBeenCalledWith(id, key, update);
  });
  it.each(['get', 'post', 'patch'] as const)(
    'denies unauthenticated %s with closed no-store error',
    async (method) => {
      const path = `/procurement/suppliers${method === 'patch' ? `/${id}` : ''}`;
      closed(
        await http(method, path, false)
          .set('Idempotency-Key', key)
          .send(
            method === 'post' ? input : method === 'patch' ? update : undefined,
          ),
        401,
        'UNAUTHORIZED',
      );
      noCalls();
    },
  );
  it.each([
    ['get', '/procurement/suppliers?status=ALL', ['create']],
    ['patch', `/procurement/suppliers/${id}`, ['update']],
    ['patch', `/procurement/suppliers/${id}`, ['read']],
    ['post', '/procurement/suppliers', ['read']],
  ] as const)(
    'denies insufficient %s permissions %j',
    async (method, path, actions) => {
      permissions = [...actions];
      closed(
        await http(method, path)
          .set('Idempotency-Key', key)
          .send(
            method === 'get' ? undefined : method === 'post' ? input : update,
          ),
        403,
        'FORBIDDEN',
      );
      noCalls();
    },
  );
  it.each([
    '/procurement/suppliers',
    '/procurement/suppliers?status=active',
    '/procurement/suppliers?status=ALL&status=ACTIVE',
    '/procurement/suppliers?status=ALL&limit=01',
    '/procurement/suppliers?status=ALL&limit=101',
    '/procurement/suppliers?status=ALL&tenantId=other',
    `/procurement/suppliers?status=ALL&search=${'x'.repeat(201)}`,
    '/procurement/suppliers/not-a-uuid',
    '/procurement/suppliers/%E0%A4%A',
    `/procurement/suppliers/${id}?extra=1`,
  ])('rejects malformed query/id %s without effects', async (path) => {
    closed(await http('get', path), 400, 'MALFORMED');
    noCalls();
  });
  it.each([
    {},
    { ...input, tenantId: 'other' },
    { ...input, displayName: ' ' },
    { ...input, termsText: 1 },
    { ...input, status: 'ALL' },
  ])('rejects create body %j before command', async (body) => {
    closed(
      await http('post').set('Idempotency-Key', key).send(body),
      400,
      'MALFORMED',
    );
    noCalls();
  });
  it.each([
    {},
    { expectedVersion: 0, changes: { status: 'ACTIVE' } },
    { expectedVersion: 1, changes: {} },
    { ...update, extra: true },
  ])('rejects update body %j before command', async (body) => {
    closed(
      await http('patch', `/procurement/suppliers/${id}`)
        .set('Idempotency-Key', key)
        .send(body),
      400,
      'MALFORMED',
    );
    noCalls();
  });
  it('rejects missing, duplicate raw headers and query on writes before commands', async () => {
    closed(await http('post').send(input), 400, 'MALFORMED');
    closed(
      await http('post')
        .set({ 'Idempotency-Key': [key, key] })
        .send(input),
      400,
      'MALFORMED',
    );
    closed(
      await http('post', '/procurement/suppliers?x=1')
        .set('Idempotency-Key', key)
        .send(input),
      400,
      'MALFORMED',
    );
    noCalls();
  });
  it.each([
    ['POST', '/procurement/suppliers'],
    ['POST', '/PROCUREMENT/SUPPLIERS/'],
    ['PATCH', `/Procurement/Suppliers/${id}/`],
    ['GET', `/procurement/suppliers/${id}`],
  ])(
    'sanitizes malformed JSON on equivalent %s %s preserving CORS',
    async (method, path) => {
      closed(
        await http(method.toLowerCase() as 'post', path)
          .set('Content-Type', 'application/json')
          .send('{"private":"secret",'),
        400,
        'MALFORMED',
      );
      noCalls();
    },
  );
  it.each(['null', '1', 'true', '"private"', '[]'])(
    'admits primitive JSON to closed supplier parser: %s',
    async (body) => {
      closed(
        await http('post')
          .set('Idempotency-Key', key)
          .set('Content-Type', 'application/json')
          .send(body),
        400,
        'MALFORMED',
      );
      noCalls();
    },
  );
  it('maps oversized JSON to the supplier closed vocabulary, not 413', async () => {
    closed(
      await http('post')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ private: 'x'.repeat(110_000) })),
      400,
      'MALFORMED',
    );
    noCalls();
  });
  it.each([
    ['/procurement/suppliers?status=ALL', 'text/plain', 'content-length'],
    ['/procurement/suppliers?status=ALL', 'text/plain', 'chunked'],
    [
      '/procurement/suppliers?status=ALL',
      'application/octet-stream',
      'content-length',
    ],
    [
      '/procurement/suppliers?status=ALL',
      'application/octet-stream',
      'chunked',
    ],
    [`/procurement/suppliers/${id}`, 'text/plain', 'content-length'],
    [`/procurement/suppliers/${id}`, 'text/plain', 'chunked'],
    [
      `/procurement/suppliers/${id}`,
      'application/octet-stream',
      'content-length',
    ],
    [`/procurement/suppliers/${id}`, 'application/octet-stream', 'chunked'],
  ] as const)(
    'rejects unparsed GET body on %s (%s, %s)',
    async (path, contentType, framing) => {
      const body = Buffer.from('nonempty');
      const call = http('get', path).set('Content-Type', contentType);
      if (framing === 'chunked') {
        // write(), rather than send(), avoids Superagent adding Content-Length
        // alongside Transfer-Encoding (an invalid request rejected by Node).
        call.set('Transfer-Encoding', 'chunked');
        call.write(body);
      } else {
        call.set('Content-Length', String(body.length)).send(body);
      }
      const response = await call;
      // RED output exposes both the erroneous HTTP success and boundary call;
      // GREEN requires rejection before any query/command boundary is invoked.
      expect({
        status: response.status,
        listCalls: queries.list.mock.calls.length,
        detailCalls: queries.detail.mock.calls.length,
      }).toEqual({ status: 400, listCalls: 0, detailCalls: 0 });
      closed(response, 400, 'MALFORMED');
      noCalls();
    },
  );
  it.each([
    ['/procurement/suppliers?status=ALL', 'application/json', false],
    ['/procurement/suppliers?status=ALL', 'application/json', true],
    [
      '/procurement/suppliers?status=ALL',
      'application/x-www-form-urlencoded',
      false,
    ],
    [
      '/procurement/suppliers?status=ALL',
      'application/x-www-form-urlencoded',
      true,
    ],
    ['/procurement/suppliers?status=ALL', 'text/plain', false],
    ['/procurement/suppliers?status=ALL', 'text/plain', true],
    ['/procurement/suppliers?status=ALL', 'application/octet-stream', false],
    ['/procurement/suppliers?status=ALL', 'application/octet-stream', true],
    [`/procurement/suppliers/${id}`, 'application/json', false],
    [`/procurement/suppliers/${id}`, 'application/json', true],
    [
      `/procurement/suppliers/${id}`,
      'application/x-www-form-urlencoded',
      false,
    ],
    [`/procurement/suppliers/${id}`, 'application/x-www-form-urlencoded', true],
    [`/procurement/suppliers/${id}`, 'text/plain', false],
    [`/procurement/suppliers/${id}`, 'text/plain', true],
    [`/procurement/suppliers/${id}`, 'application/octet-stream', false],
    [`/procurement/suppliers/${id}`, 'application/octet-stream', true],
  ] as const)(
    'accepts bodyless GET on %s (%s, explicit zero length=%s)',
    async (path, contentType, zeroLength) => {
      const call = http('get', path).set('Content-Type', contentType);
      if (zeroLength) call.set('Content-Length', '0');
      const response = await call;
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['access-control-allow-origin']).toBe(
        'https://offline.example',
      );
      expect(response.body).toEqual(
        path.includes('?') ? { items: [supplier], nextCursor: null } : supplier,
      );
      expect(commands.create).not.toHaveBeenCalled();
      expect(commands.update).not.toHaveBeenCalled();
    },
  );
  it('rejects a JSON detail GET body', async () => {
    closed(
      await http('get', `/procurement/suppliers/${id}`).send({}),
      400,
      'MALFORMED',
    );
    noCalls();
  });
  it('rejects a GET body', async () => {
    closed(
      await http('get', '/procurement/suppliers?status=ALL').send({}),
      400,
      'MALFORMED',
    );
    noCalls();
  });
  it.each([
    ['NOT_FOUND', 404],
    ['FORBIDDEN', 403],
    ['UNAUTHORIZED', 401],
    ['SUPPLIER_VERSION_CONFLICT', 409],
    ['IDEMPOTENCY_KEY_CONFLICT', 409],
    ['IDEMPOTENCY_KEY_IN_FLIGHT', 409],
    ['INTERNAL_ERROR', 500],
  ] as const)(
    'maps current authority/command %s and never retries',
    async (code, status) => {
      commands.update.mockRejectedValueOnce(new SupplierContractError(code));
      closed(
        await http('patch', `/procurement/suppliers/${id}`)
          .set('Idempotency-Key', key)
          .send(update),
        status,
        code,
      );
      expect(commands.update).toHaveBeenCalledTimes(1);
    },
  );
  it('sanitizes unexpected driver errors', async () => {
    queries.detail.mockRejectedValueOnce(new Error('private database details'));
    closed(
      await http('get', `/procurement/suppliers/${id}`),
      500,
      'INTERNAL_ERROR',
    );
  });
  it('leaves default non-supplier body parser unchanged', async () => {
    const valid = await request(app.getHttpServer() as Server)
      .post('/unrelated-parser-proof')
      .send({ ok: true });
    expect(valid.body).toEqual({ ok: true });
    const primitive = await request(app.getHttpServer() as Server)
      .post('/unrelated-parser-proof')
      .set('Content-Type', 'application/json')
      .send('1');
    expect(primitive.status).toBe(400);
    expect(primitive.body).not.toEqual({ statusCode: 400, error: 'MALFORMED' });
    const sibling = await request(app.getHttpServer() as Server)
      .post('/procurement/suppliers-extra')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(sibling.status).toBe(400);
    expect(sibling.headers['cache-control']).toBeUndefined();
  });
  it.each([
    ['post', `/procurement/suppliers/${id}/history`],
    ['delete', `/procurement/suppliers/${id}`],
  ] as const)(
    'keeps default parsers on unsupported %s %s',
    async (method, path) => {
      const result = await request(app.getHttpServer() as Server)
        [method](path)
        .set('Content-Type', 'application/json')
        .send('{');
      expect(result.status).toBe(400);
      expect(result.body).not.toEqual({ statusCode: 400, error: 'MALFORMED' });
      expect(result.headers['cache-control']).toBeUndefined();
      noCalls();
    },
  );
  it('does not expose history or delete routes', async () => {
    expect(
      (await http('get', `/procurement/suppliers/${id}/history`)).status,
    ).toBe(404);
    expect(
      (
        await request(app.getHttpServer() as Server).delete(
          `/procurement/suppliers/${id}`,
        )
      ).status,
    ).toBe(404);
    noCalls();
  });
});
