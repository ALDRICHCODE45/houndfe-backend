import 'reflect-metadata';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { CustomerBulkSelectionResolver } from './customer-bulk-selection.resolver';
import type { CustomersBulkExportBodyDto } from './customers-bulk-export.dto';
import { CustomersBulkExportService } from './customers-bulk-export.service';
import { CustomersBulkController } from './customers-bulk.controller';

function ability(grants: Array<[AppActions, AppSubjects]>): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const [action, subject] of grants) can(action, subject);
  return build();
}

function world() {
  const csv = Buffer.from('\uFEFFx\r\n', 'utf8');
  const service = {
    export: jest.fn().mockResolvedValue({
      filename: 'clientes-2026-11-27.csv',
      csv,
      rowCount: 0,
      withMetrics: false,
    }),
    logDenied: jest.fn(),
  };
  const controller = new CustomersBulkController(
    service as unknown as CustomersBulkExportService,
  );
  const res = { set: jest.fn().mockReturnThis(), send: jest.fn() };
  return { controller, service, res, csv };
}

const body = {
  selection: { mode: 'filter', filter: {} },
} as CustomersBulkExportBodyDto;
const user = {
  userId: 'u1',
  tenantId: 't1',
  email: 'x@y',
  tenantSlug: 't',
  isSuperAdmin: false,
};

describe('CustomersBulkController — POST /customers/bulk/export', () => {
  it('route guard needs read:Customer AND export:Customer', () => {
    const handler = Object.getOwnPropertyDescriptor(
      CustomersBulkController.prototype,
      'export',
    )?.value as object;
    const required = Reflect.getMetadata(PERMISSIONS_KEY, handler) as unknown;
    expect(required).toEqual([
      ['read', 'Customer'],
      ['export', 'Customer'],
    ]);
  });

  it('manage:Customer without the explicit row → standard 403 INSUFFICIENT_PERMISSIONS, nothing exported', async () => {
    const { controller, service, res } = world();
    await expect(
      controller.export(
        body,
        { ability: ability([['manage', 'Customer']]), user } as never,
        res as never,
      ),
    ).rejects.toBeInstanceOf(InsufficientPermissionsError);
    expect(service.export).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('the explicit-permission denial is logged once as forbidden (who, tenant, reason)', async () => {
    const { controller, service, res } = world();
    await expect(
      controller.export(
        body,
        { ability: ability([['manage', 'Customer']]), user } as never,
        res as never,
      ),
    ).rejects.toBeInstanceOf(InsufficientPermissionsError);
    expect(service.logDenied).toHaveBeenCalledTimes(1);
    expect(service.logDenied).toHaveBeenCalledWith(
      body,
      { userId: 'u1', tenantId: 't1' },
      'EXPORT_PERMISSION_NOT_EXPLICIT',
    );
  });

  it('an allowed export does not log a denial', async () => {
    const { controller, service, res } = world();
    const a = ability([
      ['read', 'Customer'],
      ['export', 'Customer'],
    ]);
    await controller.export(body, { ability: a, user } as never, res as never);
    expect(service.logDenied).not.toHaveBeenCalled();
  });

  it('export:Customer → CSV headers and body', async () => {
    const { controller, service, res, csv } = world();
    const a = ability([
      ['read', 'Customer'],
      ['export', 'Customer'],
    ]);
    await controller.export(body, { ability: a, user } as never, res as never);
    expect(service.export).toHaveBeenCalledWith(body, a, {
      userId: 'u1',
      tenantId: 't1',
    });
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clientes-2026-11-27.csv"',
      'Cache-Control': 'no-store',
    });
    expect(res.send).toHaveBeenCalledWith(csv);
  });
});

/**
 * Advisory R3-filter-proto-key: a raw JSON body whose `selection.filter` has
 * an OWN `__proto__` / `constructor` / `prototype` key must get the same 400
 * as any unknown listing param — through the real global pipe, controller,
 * service and resolver (only the readers are faked).
 */
describe('CustomersBulkController — reserved keys in selection.filter (HTTP)', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as Server;
  const summarize = jest.fn().mockResolvedValue({ count: 0 });
  const findPage = jest.fn().mockResolvedValue([]);
  const exporter = ability([
    ['read', 'Customer'],
    ['export', 'Customer'],
  ]);

  beforeAll(async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const attach = {
      canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
        req.user = user;
        req.ability = exporter;
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [CustomersBulkController],
      providers: [
        {
          provide: CustomersBulkExportService,
          useFactory: () =>
            new CustomersBulkExportService(
              new CustomerBulkSelectionResolver(
                { summarize, findPage, listOptions: jest.fn() },
                { findExistingIds: jest.fn() },
                config,
                () => new Date('2026-11-27T12:00:00.000Z'),
              ),
              config,
              () => new Date('2026-11-27T12:00:00.000Z'),
            ),
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(attach)
      .overrideGuard(TenantContextGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    summarize.mockClear();
    findPage.mockClear();
  });

  const post = (raw: string) =>
    request(server())
      .post('/customers/bulk/export')
      .set('Content-Type', 'application/json')
      .send(raw);

  it('control: a plain filter exports (200)', async () => {
    const res = await post('{"selection":{"mode":"filter","filter":{}}}');
    expect(res.status).toBe(200);
  });

  it('control: an unknown filter param → 400 whitelistValidation', async () => {
    const res = await post(
      '{"selection":{"mode":"filter","filter":{"nope":"x"}}}',
    );
    expect(res.status).toBe(400);
    expect(
      (res.body as { message: Array<{ property: string }> }).message.map(
        (e) => e.property,
      ),
    ).toEqual(['nope']);
  });

  it.each([
    ['__proto__', '"x"'],
    ['__proto__', '["hasDebt"]'],
    ['__proto__', '{"hasDebt":"true"}'],
    ['constructor', '"x"'],
    ['constructor', '["x"]'],
    ['prototype', '"x"'],
  ])(
    'own %s key (value %s) → 400 like an unknown param, nothing read',
    async (key, value) => {
      const res = await post(
        `{"selection":{"mode":"filter","filter":{"hasPets":"true","${key}":${value}}}}`,
      );
      expect(res.status).toBe(400);
      const messages = (
        res.body as {
          message: Array<{
            property: string;
            constraints: Record<string, string>;
          }>;
        }
      ).message;
      expect(messages).toEqual([
        expect.objectContaining({
          property: key,
          constraints: {
            whitelistValidation: `property ${key} should not exist`,
          },
        }),
      ]);
      expect(summarize).not.toHaveBeenCalled();
      expect(findPage).not.toHaveBeenCalled();
    },
  );
});

/**
 * Reserved keys OUTSIDE `selection.filter`: Nest's validation pipe strips own
 * `__proto__` / `constructor` / `prototype` keys anywhere in the body, so the
 * interceptor rejects them at the top level and inside `selection` (and any
 * nested plain object) with the 400 an ordinary unknown property gets there.
 */
describe('CustomersBulkController — reserved keys anywhere in the body (HTTP)', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as Server;
  const summarize = jest.fn().mockResolvedValue({ count: 0 });
  const findPage = jest.fn().mockResolvedValue([]);
  const exporter = ability([
    ['read', 'Customer'],
    ['export', 'Customer'],
  ]);

  beforeAll(async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const attach = {
      canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
        req.user = user;
        req.ability = exporter;
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [CustomersBulkController],
      providers: [
        {
          provide: CustomersBulkExportService,
          useFactory: () =>
            new CustomersBulkExportService(
              new CustomerBulkSelectionResolver(
                { summarize, findPage, listOptions: jest.fn() },
                { findExistingIds: jest.fn() },
                config,
                () => new Date('2026-11-27T12:00:00.000Z'),
              ),
              config,
              () => new Date('2026-11-27T12:00:00.000Z'),
            ),
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(attach)
      .overrideGuard(TenantContextGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    summarize.mockClear();
    findPage.mockClear();
  });

  const post = (raw: string) =>
    request(server())
      .post('/customers/bulk/export')
      .set('Content-Type', 'application/json')
      .send(raw);

  const topLevel = (key: string, value: string) =>
    `{"selection":{"mode":"filter","filter":{}},"sortOrder":"asc","${key}":${value}}`;
  const inSelection = (key: string, value: string) =>
    `{"selection":{"mode":"filter","filter":{},"${key}":${value}},"sortOrder":"asc"}`;

  /** The 400 body an ordinary unknown key `nope` gets, renamed to `key`. */
  const unknownBodyFor = async (
    build: (key: string, value: string) => string,
    key: string,
  ): Promise<unknown> => {
    const control = await post(build('nope', '"x"'));
    expect(control.status).toBe(400);
    return JSON.parse(
      JSON.stringify(control.body).replace(/nope/g, key),
    ) as unknown;
  };

  it('control: a valid body exports (200)', async () => {
    const res = await post(
      '{"selection":{"mode":"filter","filter":{}},"sortOrder":"asc"}',
    );
    expect(res.status).toBe(200);
    expect(summarize).toHaveBeenCalled();
  });

  it('control: an ordinary unknown top-level key → the normal 400', async () => {
    const res = await post(topLevel('nope', '"x"'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: [
        expect.objectContaining({
          property: 'nope',
          constraints: {
            whitelistValidation: 'property nope should not exist',
          },
        }),
      ],
    });
    expect(summarize).not.toHaveBeenCalled();
  });

  const cases: Array<[string, string]> = [
    ['__proto__', '"x"'],
    ['__proto__', '["x"]'],
    ['__proto__', '{"a":"b"}'],
    ['constructor', '"x"'],
    ['constructor', '["x"]'],
    ['constructor', '{"a":"b"}'],
    ['prototype', '"x"'],
    ['prototype', '["x"]'],
    ['prototype', '{"a":"b"}'],
  ];

  it.each(cases)(
    'own top-level %s key (value %s) → the unknown-property 400, nothing read',
    async (key, value) => {
      const expected = await unknownBodyFor(topLevel, key);
      const res = await post(topLevel(key, value));
      expect(res.status).toBe(400);
      expect(res.body).toEqual(expected);
      expect(res.body).toEqual(
        expect.objectContaining({
          message: [
            expect.objectContaining({
              property: key,
              constraints: {
                whitelistValidation: `property ${key} should not exist`,
              },
            }),
          ],
        }),
      );
      expect(summarize).not.toHaveBeenCalled();
      expect(findPage).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    'own %s key inside selection (value %s) → the unknown-property 400, nothing read',
    async (key, value) => {
      const expected = await unknownBodyFor(inSelection, key);
      const res = await post(inSelection(key, value));
      expect(res.status).toBe(400);
      expect(res.body).toEqual(expected);
      expect(res.body).toEqual(
        expect.objectContaining({
          message: [
            expect.objectContaining({
              property: 'selection',
              children: [
                expect.objectContaining({
                  property: key,
                  constraints: {
                    whitelistValidation: `property ${key} should not exist`,
                  },
                }),
              ],
            }),
          ],
        }),
      );
      expect(summarize).not.toHaveBeenCalled();
      expect(findPage).not.toHaveBeenCalled();
    },
  );

  it('reports every offending path at once (top level + selection)', async () => {
    const res = await post(
      '{"selection":{"mode":"filter","filter":{},"constructor":"x"},"__proto__":"y"}',
    );
    expect(res.status).toBe(400);
    const message = (
      res.body as {
        message: Array<{ property: string; children?: unknown[] }>;
      }
    ).message;
    expect(message.map((e) => e.property).sort()).toEqual([
      '__proto__',
      'selection',
    ]);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('a reserved key in a nested plain object below selection → 400 naming the path', async () => {
    const res = await post(
      '{"selection":{"mode":"filter","filter":{},"extra":{"prototype":"x"}}}',
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        message: [
          expect.objectContaining({
            property: 'selection',
            children: [
              expect.objectContaining({
                property: 'extra',
                children: [
                  expect.objectContaining({
                    property: 'prototype',
                    constraints: {
                      whitelistValidation:
                        'property prototype should not exist',
                    },
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );
    expect(summarize).not.toHaveBeenCalled();
  });

  it('arrays of strings and ordinary keys are left to the pipe', async () => {
    const res = await post(
      '{"selection":{"mode":"filter","filter":{},"excludeIds":["__proto__"]}}',
    );
    expect(res.status).toBe(400);
    expect(
      (res.body as { message: Array<{ property: string }> }).message.map(
        (e) => e.property,
      ),
    ).toEqual(['selection']);
    expect(JSON.stringify(res.body)).toContain('isUuid');
  });
});
