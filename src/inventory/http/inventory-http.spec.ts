/* eslint-disable @typescript-eslint/require-await -- Async authorization double. */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { createMongoAbility } from '@casl/ability';
import { ClsModule } from 'nestjs-cls';
import type { Server } from 'node:http';
import request from 'supertest';
import { InventoryController } from './inventory.controller';
import { InventoryCommands } from './inventory-commands';
import { InventoryQueries } from './inventory-queries';
import { installInventoryBodyParser } from './inventory-body-parser';
import { InventoryContractError } from './inventory-contract';
import { JwtStrategy } from '../../auth/infrastructure/strategies/jwt.strategy';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';

const P = '10000000-0000-4000-8000-000000000001';
const adjustment = {
  target: { productId: P },
  expectedVersion: 0,
  delta: -1,
  reason: 'DAMAGE',
};

describe('inventory HTTP boundary (offline; real JWT/CLS/permission guards)', () => {
  let app: INestApplication;
  let token: string;
  let permissions: Array<{ action: string; subject: string }>;
  const commands = { adjust: jest.fn() };
  const queries = { getStock: jest.fn(), listMovements: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      ],
      controllers: [InventoryController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        TenantContextGuard,
        PermissionsGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: 'offline-only' }),
        },
        { provide: InventoryCommands, useValue: commands },
        { provide: InventoryQueries, useValue: queries },
        {
          provide: CaslAbilityFactory,
          useValue: {
            createForUser: async () => createMongoAbility(permissions),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    installInventoryBodyParser(app);
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
    permissions = [
      { action: 'read', subject: 'InventoryJournal' },
      { action: 'create', subject: 'InventoryAdjustment' },
    ];
    commands.adjust.mockResolvedValue({
      statusCode: 201,
      body: { movement: { id: 'm' }, stock: { lots: [] } },
    });
    queries.getStock.mockResolvedValue({ product: { id: P } });
    queries.listMovements.mockResolvedValue({ items: [], nextCursor: null });
  });
  function http(method: 'get' | 'post', path: string, auth = true) {
    const call = request(app.getHttpServer() as Server)[method](path);
    return auth ? call.set('Authorization', `Bearer ${token}`) : call;
  }
  function closed(response: request.Response, status: number, error: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ statusCode: status, error });
    expect(response.headers['cache-control']).toBe('no-store');
  }
  const post = (body: unknown = adjustment, key: string | null = 'k1') => {
    const call = http('post', '/inventory/adjustments').send(
      typeof body === 'string' ? body : JSON.stringify(body),
    );
    call.set('Content-Type', 'application/json');
    return key === null ? call : call.set('Idempotency-Key', key);
  };

  it('serves stock and movements with no-store and passes the raw inputs through', async () => {
    const stock = await http('get', `/inventory/products/${P}/stock`);
    expect(stock.status).toBe(200);
    expect(stock.headers['cache-control']).toBe('no-store');
    expect(queries.getStock).toHaveBeenCalledWith(P);
    const movements = await http(
      'get',
      `/inventory/movements?productId=${P}&limit=5`,
    );
    expect(movements.status).toBe(200);
    expect(movements.body).toEqual({ items: [], nextCursor: null });
    expect(queries.listMovements).toHaveBeenCalledWith({
      productId: P,
      limit: '5',
    });
  });

  it('creates an adjustment as 201 with the key and body handed to the command', async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      movement: { id: 'm' },
      stock: { lots: [] },
    });
    expect(commands.adjust).toHaveBeenCalledWith('k1', adjustment);
  });

  it('answers 401 UNAUTHORIZED without a token and calls nothing', async () => {
    closed(
      await http('get', `/inventory/products/${P}/stock`, false),
      401,
      'UNAUTHORIZED',
    );
    expect(queries.getStock).not.toHaveBeenCalled();
  });

  it('answers 403 FORBIDDEN per route when the grant is missing (no inheritance)', async () => {
    permissions = [
      { action: 'manage', subject: 'Product' },
      { action: 'create', subject: 'Sale' },
    ];
    closed(
      await http('get', `/inventory/products/${P}/stock`),
      403,
      'FORBIDDEN',
    );
    closed(
      await http('get', `/inventory/movements?productId=${P}`),
      403,
      'FORBIDDEN',
    );
    closed(await post(), 403, 'FORBIDDEN');
    permissions = [{ action: 'read', subject: 'InventoryJournal' }];
    closed(await post(), 403, 'FORBIDDEN');
    permissions = [{ action: 'create', subject: 'InventoryAdjustment' }];
    closed(await post(), 403, 'FORBIDDEN');
    expect(commands.adjust).not.toHaveBeenCalled();
    expect(queries.getStock).not.toHaveBeenCalled();
    expect(queries.listMovements).not.toHaveBeenCalled();
  });

  it.each([
    ['missing Idempotency-Key', () => post(adjustment, null)],
    [
      'non-JSON content type',
      () =>
        http('post', '/inventory/adjustments')
          .set('Idempotency-Key', 'k')
          .set('Content-Type', 'text/plain')
          .send('x'),
    ],
    [
      'query string on POST',
      () =>
        http('post', '/inventory/adjustments?x=1')
          .set('Idempotency-Key', 'k')
          .send(adjustment),
    ],
    ['invalid JSON', () => post('{"target":')],
    [
      'duplicate member',
      () => post('{"target":{"productId":"' + P + '"},"delta":1,"delta":2}'),
    ],
    [
      'duplicate nested member',
      () =>
        post('{"target":{"productId":"' + P + '","productId":"' + P + '"}}'),
    ],
    [
      'malformed product id',
      () => http('get', '/inventory/products/nope/stock'),
    ],
    ['query on stock', () => http('get', `/inventory/products/${P}/stock?x=1`)],
  ])('maps %s to 400 MALFORMED before any work', async (_name, call) => {
    closed(await call(), 400, 'MALFORMED');
    expect(commands.adjust).not.toHaveBeenCalled();
    expect(queries.getStock).not.toHaveBeenCalled();
  });

  it('serialises every domain failure as the closed envelope with no-store', async () => {
    const table: Array<[string, number]> = [
      ['NOT_FOUND', 404],
      ['STOCK_VERSION_CONFLICT', 409],
      ['INSUFFICIENT_STOCK', 409],
      ['STOCK_NOT_TRACKED', 409],
      ['IDEMPOTENCY_KEY_CONFLICT', 409],
      ['IDEMPOTENCY_KEY_IN_FLIGHT', 409],
      ['INTERNAL_ERROR', 500],
    ];
    for (const [code, status] of table) {
      commands.adjust.mockRejectedValueOnce(
        new InventoryContractError(code as 'NOT_FOUND'),
      );
      closed(await post(), status, code);
    }
    queries.getStock.mockRejectedValueOnce(new Error('db password leaked'));
    closed(
      await http('get', `/inventory/products/${P}/stock`),
      500,
      'INTERNAL_ERROR',
    );
  });
});
