/**
 * customers-bulk-actions / T3 (S5) — `POST /customers/bulk/statements`
 * controller: route permissions, ZIP response headers, `Retry-After` on
 * `429 BULK_EXPORT_BUSY`, client-abort signal.
 */
import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import {
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  RequestMethod,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PERMISSIONS_KEY } from '../auth/authorization/decorators/require-permissions.decorator';
import type { AppAbility } from '../auth/authorization/domain/permission';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CustomerBulkSelectionResolver } from '../customers/bulk';
import { RejectReservedBulkFilterKeysInterceptor } from '../customers/bulk/customers-bulk.controller';
import type { PdfGenerationService } from '../pdf-generation/pdf-generation.service';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import type { CustomerStatementService } from './customer-statement.service';
import { BulkExportBusyException } from './customer-bulk-statements.busy-guard';
import { CustomerBulkStatementsController } from './customer-bulk-statements.controller';
import { CustomerBulkStatementsRunGuard } from './customer-bulk-statements.busy-guard';
import { CustomerBulkStatementsService } from './customer-bulk-statements.service';
import type { CustomerBulkStatementsBodyDto } from './dto/customer-bulk-statements.dto';

const body = {
  selection: { mode: 'filter', filter: {} },
  from: '2026-11-01',
  to: '2026-12-01',
} as unknown as CustomerBulkStatementsBodyDto;
const user = { userId: 'u1', tenantId: 't1' };

function fakeResponse() {
  const res = new EventEmitter() as EventEmitter & {
    set: jest.Mock;
    setHeader: jest.Mock;
    send: jest.Mock;
    writableEnded: boolean;
  };
  res.set = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  res.send = jest.fn();
  res.writableEnded = false;
  return res;
}

function world(build: jest.Mock) {
  const service = { build } as unknown as CustomerBulkStatementsService;
  return new CustomerBulkStatementsController(service);
}

const handler = () =>
  Object.getOwnPropertyDescriptor(
    CustomerBulkStatementsController.prototype,
    'statements',
  )?.value as object;

describe('CustomerBulkStatementsController — POST /customers/bulk/statements', () => {
  it('route: POST customers/bulk/statements', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, CustomerBulkStatementsController),
    ).toBe('customers/bulk');
    expect(Reflect.getMetadata(PATH_METADATA, handler())).toBe('statements');
    expect(Reflect.getMetadata(METHOD_METADATA, handler())).toBe(
      RequestMethod.POST,
    );
  });

  it('route guard needs read:Sale (the single statement permission) AND read:Customer (the selection reads the customer table)', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler())).toEqual([
      ['read', 'Sale'],
      ['read', 'Customer'],
    ]);
  });

  it('rejects reserved keys in selection.filter before the pipes (same interceptor as the CSV export)', () => {
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler())).toEqual([
      RejectReservedBulkFilterKeysInterceptor,
    ]);
  });

  it('sends the ZIP with application/zip, attachment filename, no-store and Content-Length', async () => {
    const zip = Buffer.from('PK\x05\x06zip');
    const build = jest.fn().mockResolvedValue({
      filename: 'estados-de-cuenta-2026-11-01-2026-12-01.zip',
      zip,
      count: 2,
      entryNames: [],
    });
    const res = fakeResponse();
    const ability = { can: () => true };
    await world(build).statements(
      body,
      { ability, user } as never,
      res as never,
    );

    const anySignal: unknown = expect.any(AbortSignal);
    expect(build).toHaveBeenCalledWith(
      body,
      ability,
      { userId: 'u1', tenantId: 't1' },
      { signal: anySignal },
    );
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'application/zip',
      'Content-Disposition':
        'attachment; filename="estados-de-cuenta-2026-11-01-2026-12-01.zip"',
      'Content-Length': String(zip.length),
      'Cache-Control': 'no-store',
    });
    expect(res.send).toHaveBeenCalledWith(zip);
    // The close listener is removed once the run is over.
    expect(res.listenerCount('close')).toBe(0);
  });

  it('429 BULK_EXPORT_BUSY → sets Retry-After: 10 and rethrows; nothing sent', async () => {
    const build = jest.fn().mockRejectedValue(new BulkExportBusyException());
    const res = fakeResponse();
    await expect(
      world(build).statements(
        body,
        { ability: {}, user } as never,
        res as never,
      ),
    ).rejects.toBeInstanceOf(BulkExportBusyException);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '10');
    expect(res.send).not.toHaveBeenCalled();
  });

  it('other errors propagate without Retry-After', async () => {
    const build = jest.fn().mockRejectedValue(new Error('boom'));
    const res = fakeResponse();
    await expect(
      world(build).statements(
        body,
        { ability: {}, user } as never,
        res as never,
      ),
    ).rejects.toThrow('boom');
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  });

  it('a client disconnect before the response aborts the run signal', async () => {
    let seen: AbortSignal | undefined;
    const res = fakeResponse();
    const build = jest.fn(
      (
        _b: unknown,
        _a: unknown,
        _u: unknown,
        opts: { signal: AbortSignal },
      ) => {
        seen = opts.signal;
        res.emit('close');
        return Promise.resolve({ filename: 'x.zip', zip: Buffer.alloc(0) });
      },
    );
    await world(build).statements(
      body,
      { ability: {}, user } as never,
      res as never,
    );
    expect(seen?.aborted).toBe(true);
  });

  it('missing request.ability is a wiring error', async () => {
    const build = jest.fn();
    await expect(
      world(build).statements(body, { user } as never, fakeResponse() as never),
    ).rejects.toThrow(/request\.ability/);
    expect(build).not.toHaveBeenCalled();
  });
});

/**
 * Through the real global pipe, interceptor, controller, service and resolver
 * (only the readers, statement service and renderer are faked): an own
 * `__proto__` key in `selection.filter` gets the same 400 as an unknown param.
 */
describe('CustomerBulkStatementsController — reserved keys in selection.filter (HTTP)', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as Server;
  const summarize = jest.fn().mockResolvedValue({ count: 1 });
  const findPage = jest.fn().mockResolvedValue([]);

  beforeAll(async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    can('read', 'Sale');
    can('read', 'Customer');
    const granted = build();
    const attach = {
      canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
        req.user = user;
        req.ability = granted;
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [CustomerBulkStatementsController],
      providers: [
        {
          provide: CustomerBulkStatementsService,
          useFactory: () =>
            new CustomerBulkStatementsService(
              new CustomerBulkSelectionResolver(
                { summarize, findPage, listOptions: jest.fn() },
                { findExistingIds: jest.fn() },
                config,
                () => new Date('2026-11-27T12:00:00.000Z'),
              ),
              {
                getStatement: jest.fn(),
              } as unknown as CustomerStatementService,
              {
                renderCustomerStatementPdf: jest.fn(),
              } as unknown as PdfGenerationService,
              new CustomerBulkStatementsRunGuard(),
              config,
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

  const post = (filter: string) =>
    request(server())
      .post('/customers/bulk/statements')
      .set('Content-Type', 'application/json')
      .send(
        `{"selection":{"mode":"filter","filter":${filter}},"from":"2026-11-01","to":"2026-12-01"}`,
      );

  const messagesOf = (body: unknown) =>
    (
      body as {
        message: Array<{
          property: string;
          constraints: Record<string, string>;
        }>;
      }
    ).message;

  it('control: an unknown filter param → 400 whitelistValidation', async () => {
    const res = await post('{"nope":"x"}');
    expect(res.status).toBe(400);
    expect(messagesOf(res.body)).toEqual([
      expect.objectContaining({
        property: 'nope',
        constraints: { whitelistValidation: 'property nope should not exist' },
      }),
    ]);
  });

  it('own __proto__ key → the same 400, nothing read', async () => {
    const res = await post('{"hasPets":"true","__proto__":"x"}');
    expect(res.status).toBe(400);
    expect(messagesOf(res.body)).toEqual([
      expect.objectContaining({
        property: '__proto__',
        constraints: {
          whitelistValidation: 'property __proto__ should not exist',
        },
      }),
    ]);
    expect(summarize).not.toHaveBeenCalled();
    expect(findPage).not.toHaveBeenCalled();
  });
});
