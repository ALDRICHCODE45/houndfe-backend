/**
 * T3 — HTTP contract for the cash-register presentation layer (S1,S2,S3,S4,S5,
 * S7,S8).
 *
 * In-memory Nest app + Supertest (`app.init()`, NO listen port, NO DB, NO
 * module wiring): the REAL `PermissionsGuard` runs against a REAL CASL ability
 * built per user by a mocked `CaslAbilityFactory`, and the global
 * `ValidationPipe` mirrors `main.ts` exactly (`whitelist`, `forbidNonWhitelisted`,
 * `transform`, listing exception factory) with the real `DomainExceptionFilter`.
 * Only `JwtAuthGuard` and `TenantContextGuard` are typed doubles (they populate
 * `request.user` from a bearer token), and `ICashApplication` is a mock.
 *
 * What is proven here:
 *   - guard order / class-level `@UseGuards` metadata on every controller;
 *   - authentication and granular permission denial never reach the application;
 *   - a dynamic per-user ability dispatches the correct command and forwards
 *     the JWT-derived actor (`{ userId, ability }`);
 *   - every command route requires a normalized, bounded `Idempotency-Key`;
 *   - structural validation of UUIDs, cents, counts, null optional fields,
 *     timezoned dates and extra body/query keys;
 *   - the blind-count seam: no expected/difference/body-kind is accepted, and
 *     the post-submission ANNOTATE_DECLARATION route is the only notes path.
 *
 * Deliberately NOT proven here: tenant/ownership/state enforcement (application
 * layer, T4), real persistence or closing receipt (T5), module wiring
 * (parent-owned).
 */
import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
  type ExecutionContext,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import request from 'supertest';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import {
  CASH_APPLICATION,
  type CashCommand,
  type CashDocument,
  type CashQuery,
} from '../cash-application.port';
import { CashRegisterController } from './cash-register.controller';
import { CashSessionController } from './cash-session.controller';
import { CashHandoverController } from './cash-handover.controller';
import { CashClosingController } from './cash-closing.controller';

type PermissionTuple = [AppActions, AppSubjects];

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REGISTER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const HANDOVER_ID = '33333333-3333-4333-8333-333333333333';
const CLOSING_ID = '44444444-4444-4444-8444-444444444444';
const RECIPIENT_ID = '55555555-5555-4555-8555-555555555555';

const FIXED_DOCUMENT: CashDocument = { ok: true, id: SESSION_ID };

const FULL_PERMISSIONS: PermissionTuple[] = [
  ['create', 'CashRegister'],
  ['read', 'CashRegister'],
  ['update', 'CashRegister'],
  ['create', 'CashSession'],
  ['read', 'CashSession'],
  ['create', 'CashCount'],
  ['create', 'CashIn'],
  ['create', 'CashOut'],
  ['create', 'CashVerification'],
  ['create', 'CashHandover'],
  ['read', 'CashHandover'],
  ['update', 'CashHandover'],
  ['create', 'CashClosing'],
  ['read', 'CashClosing'],
];

/** userId -> granted permission tuples (token === userId). */
const PERMISSIONS: Record<string, PermissionTuple[]> = {
  'user-full': FULL_PERMISSIONS,
  'user-register-reader': [['read', 'CashRegister']],
  'user-session-reader': [['read', 'CashSession']],
  'user-closing-reader': [['read', 'CashClosing']],
  'user-cash-in-only': [['create', 'CashIn']],
  'user-count-only': [['create', 'CashCount']],
  'user-custody-reader': [['read', 'CashHandover']],
  'user-audit-only': [['read', 'CashSessionAudit']],
  'user-no-perms': [],
  'user-super': [['manage', 'all']],
};

interface TestPrincipal extends AuthenticatedUser {
  permissions: PermissionTuple[];
}

const principal = (userId: string): TestPrincipal => ({
  userId,
  email: `${userId}@houndfe.test`,
  tenantId: TENANT_ID,
  tenantSlug: 'centro',
  isSuperAdmin: false,
  permissions: PERMISSIONS[userId] ?? [],
});

const PRINCIPALS: Record<string, TestPrincipal> = Object.fromEntries(
  Object.keys(PERMISSIONS).map((userId) => [userId, principal(userId)]),
);

const PRINCIPAL_LOOKUP = PRINCIPALS;

/** Build a REAL CASL ability from the granted tuples. */
function buildAbility(permissions: PermissionTuple[]): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const [action, subject] of permissions) {
    can(action, subject);
  }
  return build();
}

class TestJwtAuthGuard {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: TestPrincipal;
    }>();
    const raw = req.headers.authorization;
    const bearer = Array.isArray(raw) ? raw[0] : raw;
    const token = bearer?.startsWith('Bearer ')
      ? bearer.slice('Bearer '.length)
      : undefined;
    const user = token ? PRINCIPAL_LOOKUP[token] : undefined;
    if (!user) {
      throw new UnauthorizedException('Bearer authentication required');
    }
    req.user = user;
    return true;
  }
}

class TestTenantContextGuard {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: TestPrincipal }>();
    const user = req.user;
    if (!user?.tenantId && !user?.isSuperAdmin) {
      throw new UnauthorizedException('Tenant context required');
    }
    return true;
  }
}

const VALID_COUNT_BODY = {
  lines: [
    { channelKey: 'CASH', amountCents: 12000 },
    { channelKey: 'METHOD:CARD_CREDIT', amountCents: 5000 },
  ],
  notes: 'Conteo inicial',
};

const VALID_HANDOVER_BODY = {
  handoverKind: 'WITHDRAWAL',
  recipientUserId: RECIPIENT_ID,
  declaredCents: 12000,
  notes: 'Entrego fondo',
};

describe('Cash register HTTP contract (T3 presentation)', () => {
  let app: INestApplication;
  let execute: jest.Mock<Promise<CashDocument>, [unknown, CashCommand, string]>;
  let query: jest.Mock<Promise<CashDocument>, [unknown, CashQuery]>;
  let createForUser: jest.Mock<Promise<AppAbility>, [string]>;

  const http = () => request(app.getHttpServer() as import('node:http').Server);

  const authed = (
    token: string | null,
    method: 'get' | 'post' | 'patch',
    path: string,
  ) => {
    const test = http()[method](path);
    return token === null ? test : test.set('Authorization', `Bearer ${token}`);
  };

  const get = (path: string, token: string | null = 'user-full') =>
    authed(token, 'get', path);

  const command = (
    path: string,
    body: unknown,
    options: { token?: string | null; key?: string | null } = {},
  ) => {
    const { token = 'user-full', key = 'idem-key' } = options;
    const test = authed(token, 'post', path);
    if (key !== null) {
      test.set('Idempotency-Key', key);
    }
    return body === undefined ? test : test.send(body as object);
  };

  const patch = (
    path: string,
    body: unknown,
    options: { token?: string | null; key?: string | null } = {},
  ) => {
    const { token = 'user-full', key = 'idem-key' } = options;
    const test = authed(token, 'patch', path);
    if (key !== null) {
      test.set('Idempotency-Key', key);
    }
    return body === undefined ? test : test.send(body as object);
  };

  const lastCommand = (): CashCommand => execute.mock.calls[0][1];

  const lastActor = (): { userId: string; ability: AppAbility } =>
    execute.mock.calls[0][0] as { userId: string; ability: AppAbility };

  const lastQueryActor = (): { userId: string; ability: AppAbility } =>
    query.mock.calls[0][0] as { userId: string; ability: AppAbility };

  const lastQuery = (): CashQuery => query.mock.calls[0][1];

  beforeEach(async () => {
    execute = jest.fn<Promise<CashDocument>, [unknown, CashCommand, string]>();
    execute.mockResolvedValue(FIXED_DOCUMENT);
    query = jest.fn<Promise<CashDocument>, [unknown, CashQuery]>();
    query.mockResolvedValue(FIXED_DOCUMENT);
    createForUser = jest.fn<Promise<AppAbility>, [string]>((userId: string) =>
      Promise.resolve(buildAbility(PERMISSIONS[userId] ?? [])),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [
        CashRegisterController,
        CashSessionController,
        CashHandoverController,
        CashClosingController,
      ],
      providers: [
        PermissionsGuard,
        { provide: CaslAbilityFactory, useValue: { createForUser } },
        { provide: CASH_APPLICATION, useValue: { execute, query } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard)
      .overrideGuard(TenantContextGuard)
      .useClass(TestTenantContextGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        validationError: { target: false, value: false },
        exceptionFactory: createListingValidationExceptionFactory(),
      }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('guard wiring', () => {
    it.each([
      CashRegisterController,
      CashSessionController,
      CashHandoverController,
      CashClosingController,
    ])(
      'guards %s with JwtAuthGuard, TenantContextGuard, PermissionsGuard in order',
      (controller) => {
        const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) ??
          []) as unknown[];
        expect(guards).toEqual([
          JwtAuthGuard,
          TenantContextGuard,
          PermissionsGuard,
        ]);
      },
    );

    it('rejects a request without a bearer token and never calls the application', async () => {
      await get('/cash-registers', null).expect(401);
      expect(query).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('cash registers', () => {
    it('forwards GET /cash-registers as the REGISTERS query with the trusted actor', async () => {
      const res = await get('/cash-registers').expect(200);

      expect(res.body).toEqual(FIXED_DOCUMENT);
      expect(query).toHaveBeenCalledTimes(1);
      expect(lastQuery()).toEqual({ kind: 'REGISTERS' });
      expect(lastQueryActor().userId).toBe('user-full');
      expect(lastQueryActor().ability.can('read', 'CashRegister')).toBe(true);
    });

    it('creates a register as CREATE_REGISTER with a trimmed idempotency key', async () => {
      const res = await command(
        '/cash-registers',
        { name: '  Caja principal  ' },
        { key: '   key-register   ' },
      ).expect(201);

      expect(res.body).toEqual(FIXED_DOCUMENT);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(lastCommand()).toEqual({
        kind: 'CREATE_REGISTER',
        name: 'Caja principal',
      });
      expect(execute.mock.calls[0][2]).toBe('key-register');
    });

    it('updates a register as UPDATE_REGISTER and forwards only supplied fields', async () => {
      await patch(`/cash-registers/${REGISTER_ID}`, { isActive: false }).expect(
        200,
      );

      expect(lastCommand()).toEqual({
        kind: 'UPDATE_REGISTER',
        id: REGISTER_ID,
        isActive: false,
      });
    });

    it('rejects a non-UUID register id with 400 and never calls the application', async () => {
      await patch('/cash-registers/not-a-uuid', { name: 'X' }).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a create body carrying an authority field (forbidNonWhitelisted)', async () => {
      await command('/cash-registers', {
        name: 'Caja',
        tenantId: TENANT_ID,
      }).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('denies a reader without create:CashRegister and never calls the application', async () => {
      await command(
        '/cash-registers',
        { name: 'Caja' },
        { token: 'user-register-reader' },
      ).expect(403);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('open session (POST /cash-registers/:id/sessions)', () => {
    const url = `/cash-registers/${REGISTER_ID}/sessions`;

    it('opens a session with openingConfirmed=true mapped to OPEN_SESSION', async () => {
      await command(url, {
        openingCents: 0,
        openingConfirmed: true,
      }).expect(201);

      expect(lastCommand()).toEqual({
        kind: 'OPEN_SESSION',
        registerId: REGISTER_ID,
        openingCents: 0,
        openingConfirmed: true,
      });
    });

    it('forwards an optional opening handover id', async () => {
      await command(url, {
        openingCents: 1000,
        openingHandoverId: HANDOVER_ID,
        openingConfirmed: true,
      }).expect(201);

      expect(lastCommand()).toEqual({
        kind: 'OPEN_SESSION',
        registerId: REGISTER_ID,
        openingCents: 1000,
        openingHandoverId: HANDOVER_ID,
        openingConfirmed: true,
      });
    });

    it.each([
      ['false', { openingCents: 0, openingConfirmed: false }],
      ['a string', { openingCents: 0, openingConfirmed: 'true' }],
      ['a missing confirmation', { openingCents: 0 }],
    ])('rejects openingConfirmed as %s', async (_case, body) => {
      await command(url, body).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it.each([
      ['a negative amount', { openingCents: -1, openingConfirmed: true }],
      ['a fractional amount', { openingCents: 1.5, openingConfirmed: true }],
      [
        'an amount above the cents ceiling',
        { openingCents: 2147483648, openingConfirmed: true },
      ],
      ['a string amount', { openingCents: '100', openingConfirmed: true }],
      [
        'a null optional handover id',
        {
          openingCents: 0,
          openingHandoverId: null,
          openingConfirmed: true,
        },
      ],
    ])('rejects %s with 400', async (_case, body) => {
      await command(url, body).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('requires create:CashSession and never calls the application otherwise', async () => {
      await command(
        url,
        { openingCents: 0, openingConfirmed: true },
        { token: 'user-register-reader' },
      ).expect(403);
      expect(execute).not.toHaveBeenCalled();
    });

    it('requires an idempotency key', async () => {
      await command(
        url,
        { openingCents: 0, openingConfirmed: true },
        { key: null },
      ).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('sessions read/list', () => {
    it('defaults page=1 and limit=25 and forwards an omitted pendingOnly', async () => {
      await get('/cash-sessions').expect(200);

      expect(lastQuery()).toEqual({
        kind: 'SESSIONS',
        page: { page: 1, limit: 25 },
      });
    });

    it('forwards filters, a timezoned range and pendingOnly=true', async () => {
      await get('/cash-sessions')
        .query({
          page: '2',
          limit: '50',
          registerId: REGISTER_ID,
          cashierUserId: RECIPIENT_ID,
          from: '2026-01-01T00:00:00Z',
          to: '2026-02-01T00:00:00.000Z',
          pendingOnly: 'true',
        })
        .expect(200);

      expect(lastQuery()).toEqual({
        kind: 'SESSIONS',
        page: {
          page: 2,
          limit: 50,
          registerId: REGISTER_ID,
          cashierUserId: RECIPIENT_ID,
          from: '2026-01-01T00:00:00Z',
          to: '2026-02-01T00:00:00.000Z',
        },
        pendingOnly: true,
      });
    });

    it('gets a single session as the SESSION query', async () => {
      await get(`/cash-sessions/${SESSION_ID}`).expect(200);

      expect(lastQuery()).toEqual({ kind: 'SESSION', id: SESSION_ID });
    });

    it.each([
      ['a non-UUID register filter', { registerId: 'nope' }],
      ['a non-UUID cashier filter', { cashierUserId: 'nope' }],
      ['a local timestamp without timezone', { from: '2026-01-01T00:00:00' }],
      ['an unparseable date', { from: '2026-13-01T00:00:00Z' }],
      ['a zero page', { page: '0' }],
      ['a limit above the cap', { limit: '101' }],
      ['a float limit', { limit: '1.5' }],
      ['an unknown query key', { tenantId: TENANT_ID }],
      ['a non-boolean pendingOnly', { pendingOnly: 'maybe' }],
    ])('rejects %s with 400', async (_case, queryParams) => {
      await get('/cash-sessions').query(queryParams).expect(400);
      expect(query).not.toHaveBeenCalled();
    });

    it('rejects a null optional filter', async () => {
      await get('/cash-sessions').query({ registerId: '' }).expect(400);
      expect(query).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID session id and never calls the application', async () => {
      await get('/cash-sessions/not-a-uuid').expect(400);
      expect(query).not.toHaveBeenCalled();
    });

    it('denies a closing-only reader and never calls the application', async () => {
      await get('/cash-sessions', 'user-closing-reader').expect(403);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('start count', () => {
    const url = `/cash-sessions/${SESSION_ID}/start-count`;

    it('starts the count as START_COUNT with a normalized key', async () => {
      await command(url, undefined, { key: '  start-1  ' }).expect(200);

      expect(lastCommand()).toEqual({
        kind: 'START_COUNT',
        sessionId: SESSION_ID,
      });
      expect(execute.mock.calls[0][2]).toBe('start-1');
    });

    it('requires create:CashCount', async () => {
      await command(url, undefined, { token: 'user-session-reader' }).expect(
        403,
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it('requires an idempotency key', async () => {
      await command(url, undefined, { key: null }).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('declarations (blind count)', () => {
    const url = `/cash-sessions/${SESSION_ID}/declarations`;

    it('maps the body to DECLARE and preserves the lines/denominations/notes', async () => {
      await command(url, {
        lines: [{ channelKey: 'CASH', amountCents: 0 }],
        denominations: [{ denominationCents: 100, quantity: 0 }],
        notes: 'Sin efectivo',
      }).expect(201);

      expect(lastCommand()).toEqual({
        kind: 'DECLARE',
        sessionId: SESSION_ID,
        lines: [{ channelKey: 'CASH', amountCents: 0 }],
        denominations: [{ denominationCents: 100, quantity: 0 }],
        notes: 'Sin efectivo',
      });
    });

    it.each([
      ['an empty lines array', { lines: [] }],
      [
        'a negative line amount',
        { lines: [{ channelKey: 'CASH', amountCents: -1 }] },
      ],
      [
        'a fractional line amount',
        { lines: [{ channelKey: 'CASH', amountCents: 1.5 }] },
      ],
      [
        'a blank channel key',
        { lines: [{ channelKey: '   ', amountCents: 10 }] },
      ],
      ['a missing channel key', { lines: [{ amountCents: 10 }] }],
      [
        'a null denominations value',
        { lines: VALID_COUNT_BODY.lines, denominations: null },
      ],
      [
        'a zero denomination',
        {
          lines: VALID_COUNT_BODY.lines,
          denominations: [{ denominationCents: 0, quantity: 1 }],
        },
      ],
      [
        'a negative quantity',
        {
          lines: VALID_COUNT_BODY.lines,
          denominations: [{ denominationCents: 100, quantity: -1 }],
        },
      ],
      [
        'a fractional quantity',
        {
          lines: VALID_COUNT_BODY.lines,
          denominations: [{ denominationCents: 100, quantity: 1.5 }],
        },
      ],
    ])('rejects %s with 400', async (_case, body) => {
      await command(url, body).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects an unknown nested line field (no source injection)', async () => {
      await command(url, {
        lines: [{ channelKey: 'CASH', amountCents: 10, sourceType: 'PAYMENT' }],
      }).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a body command kind',
        { kind: 'CASH_IN', lines: VALID_COUNT_BODY.lines },
      ],
      ['an expected value', { ...VALID_COUNT_BODY, expectedCents: 100 }],
      ['a difference value', { ...VALID_COUNT_BODY, differenceCents: 5 }],
      ['an actor field', { ...VALID_COUNT_BODY, userId: 'attacker' }],
    ])('rejects a body carrying %s', async (_case, body) => {
      await command(url, body).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('bounds the number of count lines', async () => {
      const lines = Array.from({ length: 101 }, () => ({
        channelKey: 'CASH',
        amountCents: 1,
      }));
      await command(url, { lines }).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('denies a verification-only user and never calls the application', async () => {
      await command(url, VALID_COUNT_BODY, {
        token: 'user-cash-in-only',
      }).expect(403);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('declaration notes (post-submission explanation)', () => {
    const url = `/cash-sessions/${SESSION_ID}/declaration-notes`;

    it('maps the notes to ANNOTATE_DECLARATION', async () => {
      await command(url, { notes: '  Faltó cambio  ' }).expect(201);

      expect(lastCommand()).toEqual({
        kind: 'ANNOTATE_DECLARATION',
        sessionId: SESSION_ID,
        notes: 'Faltó cambio',
      });
    });

    it.each([
      ['a missing notes field', {}],
      ['a blank notes field', { notes: '   ' }],
      ['an expected value', { notes: 'x', expectedCents: 1 }],
    ])('rejects %s with 400', async (_case, body) => {
      await command(url, body).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('requires create:CashCount and an idempotency key', async () => {
      await command(url, { notes: 'x' }, { token: 'user-cash-in-only' }).expect(
        403,
      );
      await command(url, { notes: 'x' }, { key: null }).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('verifications', () => {
    const url = `/cash-sessions/${SESSION_ID}/verifications`;

    it('maps the body to VERIFY', async () => {
      await command(url, VALID_COUNT_BODY).expect(201);

      expect(lastCommand()).toEqual({
        kind: 'VERIFY',
        sessionId: SESSION_ID,
        ...VALID_COUNT_BODY,
      });
    });

    it('requires create:CashVerification (count-only user is denied)', async () => {
      await command(url, VALID_COUNT_BODY, { token: 'user-count-only' }).expect(
        403,
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects an empty count and never calls the application', async () => {
      await command(url, { lines: [] }).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('manual cash movements', () => {
    it('maps POST cash-in to CASH_IN with the trusted actor', async () => {
      await command(`/cash-sessions/${SESSION_ID}/cash-in`, {
        amountCents: 500,
        reason: '  Venta mostrador  ',
      }).expect(201);

      expect(lastCommand()).toEqual({
        kind: 'CASH_IN',
        sessionId: SESSION_ID,
        amountCents: 500,
        reason: 'Venta mostrador',
      });
    });

    it('maps POST cash-out to CASH_OUT', async () => {
      await command(`/cash-sessions/${SESSION_ID}/cash-out`, {
        amountCents: 500,
        reason: 'Retiro',
      }).expect(201);

      expect(lastCommand()).toEqual({
        kind: 'CASH_OUT',
        sessionId: SESSION_ID,
        amountCents: 500,
        reason: 'Retiro',
      });
    });

    it('dispatches with a dynamic arbitrary ability and forwards the JWT actor', async () => {
      await command(
        `/cash-sessions/${SESSION_ID}/cash-in`,
        { amountCents: 500, reason: 'x' },
        { token: 'user-cash-in-only' },
      ).expect(201);

      expect(lastActor().userId).toBe('user-cash-in-only');
      expect(lastActor().ability.can('create', 'CashIn')).toBe(true);
      expect(lastActor().ability.can('create', 'CashOut')).toBe(false);
    });

    it('denies the cash-out route for a cash-in-only ability', async () => {
      await command(
        `/cash-sessions/${SESSION_ID}/cash-out`,
        { amountCents: 500, reason: 'x' },
        { token: 'user-cash-in-only' },
      ).expect(403);
      expect(execute).not.toHaveBeenCalled();
    });

    it.each([
      ['a zero amount', { amountCents: 0, reason: 'x' }],
      ['a negative amount', { amountCents: -5, reason: 'x' }],
      ['a fractional amount', { amountCents: 0.5, reason: 'x' }],
      ['an above-ceiling amount', { amountCents: 2147483648, reason: 'x' }],
      ['a missing reason', { amountCents: 500 }],
      ['a blank reason', { amountCents: 500, reason: '  ' }],
      [
        'a source field',
        { amountCents: 500, reason: 'x', sourceType: 'PAYMENT' },
      ],
    ])('rejects %s with 400', async (_case, body) => {
      await command(`/cash-sessions/${SESSION_ID}/cash-in`, body).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('handovers', () => {
    it('maps POST handovers to CREATE_HANDOVER', async () => {
      await command(`/cash-sessions/${SESSION_ID}/handovers`, {
        handoverKind: 'FLOAT',
        recipientUserId: RECIPIENT_ID,
        declaredCents: 12000,
      }).expect(201);

      expect(lastCommand()).toEqual({
        kind: 'CREATE_HANDOVER',
        sessionId: SESSION_ID,
        handoverKind: 'FLOAT',
        recipientUserId: RECIPIENT_ID,
        declaredCents: 12000,
      });
    });

    it.each([
      [
        'an unknown handover kind',
        { ...VALID_HANDOVER_BODY, handoverKind: 'OTHER' },
      ],
      [
        'a non-UUID recipient',
        { ...VALID_HANDOVER_BODY, recipientUserId: 'nope' },
      ],
      ['a zero declared amount', { ...VALID_HANDOVER_BODY, declaredCents: 0 }],
      [
        'a negative declared amount',
        { ...VALID_HANDOVER_BODY, declaredCents: -1 },
      ],
      [
        'a fractional declared amount',
        { ...VALID_HANDOVER_BODY, declaredCents: 1.5 },
      ],
    ])('rejects %s with 400', async (_case, body) => {
      await command(`/cash-sessions/${SESSION_ID}/handovers`, body).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('maps POST receive to RECEIVE_HANDOVER as update:CashHandover', async () => {
      await command(`/cash-handovers/${HANDOVER_ID}/receive`, {
        receivedCents: 12000,
        notes: 'Recibido',
      }).expect(200);

      expect(lastCommand()).toEqual({
        kind: 'RECEIVE_HANDOVER',
        id: HANDOVER_ID,
        receivedCents: 12000,
        notes: 'Recibido',
      });
    });

    it('accepts the justified empty receipt (receivedCents=0)', async () => {
      await command(`/cash-handovers/${HANDOVER_ID}/receive`, {
        receivedCents: 0,
      }).expect(200);

      expect(lastCommand()).toEqual({
        kind: 'RECEIVE_HANDOVER',
        id: HANDOVER_ID,
        receivedCents: 0,
      });
    });

    it('rejects a negative receipt and a create-only user', async () => {
      await command(`/cash-handovers/${HANDOVER_ID}/receive`, {
        receivedCents: -1,
      }).expect(400);
      await command(
        `/cash-handovers/${HANDOVER_ID}/receive`,
        { receivedCents: 1 },
        { token: 'user-count-only' },
      ).expect(403);
      expect(execute).not.toHaveBeenCalled();
    });

    it('maps release-drawer to RELEASE_DRAWER as create:CashHandover', async () => {
      await command(
        `/cash-sessions/${SESSION_ID}/release-drawer`,
        undefined,
      ).expect(200);

      expect(lastCommand()).toEqual({
        kind: 'RELEASE_DRAWER',
        sessionId: SESSION_ID,
      });
    });
  });

  describe('custody discovery (GET /cash-handovers/custody)', () => {
    it('forwards the default page/limit as the CUSTODY query', async () => {
      const res = await get('/cash-handovers/custody').expect(200);

      expect(res.body).toEqual(FIXED_DOCUMENT);
      expect(query).toHaveBeenCalledTimes(1);
      expect(lastQuery()).toEqual({
        kind: 'CUSTODY',
        page: { page: 1, limit: 25 },
      });
      expect(lastQueryActor().userId).toBe('user-full');
    });

    it('forwards page and limit and never a recipient/tenant override', async () => {
      await get('/cash-handovers/custody')
        .query({ page: '2', limit: '50' })
        .expect(200);

      expect(lastQuery()).toEqual({
        kind: 'CUSTODY',
        page: { page: 2, limit: 50 },
      });
    });

    it('accepts the dedicated custody reader', async () => {
      await get('/cash-handovers/custody', 'user-custody-reader').expect(200);

      expect(lastQuery()).toEqual({
        kind: 'CUSTODY',
        page: { page: 1, limit: 25 },
      });
    });

    it.each([
      ['a tenant override', { tenantId: TENANT_ID }],
      ['a recipient override', { recipientUserId: RECIPIENT_ID }],
      ['an unknown key', { cashierUserId: RECIPIENT_ID }],
      ['a zero page', { page: '0' }],
      ['a limit above the cap', { limit: '101' }],
    ])(
      'rejects %s with 400 and never calls the application',
      async (_case, params) => {
        await get('/cash-handovers/custody').query(params).expect(400);
        expect(query).not.toHaveBeenCalled();
      },
    );

    it('denies a user without read:CashHandover (audit is not a substitute)', async () => {
      await get('/cash-handovers/custody', 'user-audit-only').expect(403);
      await get('/cash-handovers/custody', 'user-no-perms').expect(403);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('closing', () => {
    it('maps POST close to CLOSE and forwards optional notes', async () => {
      await command(`/cash-sessions/${SESSION_ID}/close`, {
        notes: 'Cierre',
      }).expect(201);

      expect(lastCommand()).toEqual({
        kind: 'CLOSE',
        sessionId: SESSION_ID,
        notes: 'Cierre',
      });
    });

    it('allows an omitted notes field', async () => {
      await command(`/cash-sessions/${SESSION_ID}/close`, undefined).expect(
        201,
      );

      expect(lastCommand()).toEqual({ kind: 'CLOSE', sessionId: SESSION_ID });
    });

    it('rejects a null notes field and a non-CashClosing user', async () => {
      await command(`/cash-sessions/${SESSION_ID}/close`, {
        notes: null,
      }).expect(400);
      await command(`/cash-sessions/${SESSION_ID}/close`, undefined, {
        token: 'user-count-only',
      }).expect(403);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('closing history', () => {
    it('forwards GET /cash-closings as the CLOSINGS query', async () => {
      await get('/cash-closings').expect(200);

      expect(lastQuery()).toEqual({
        kind: 'CLOSINGS',
        page: { page: 1, limit: 25 },
      });
    });

    it('forwards GET /cash-closings/:id as the CLOSING query', async () => {
      await get(`/cash-closings/${CLOSING_ID}`).expect(200);

      expect(lastQuery()).toEqual({ kind: 'CLOSING', id: CLOSING_ID });
    });

    it('enforces read:CashClosing distinct from read:CashSession', async () => {
      await get('/cash-closings', 'user-session-reader').expect(403);
      await get('/cash-sessions', 'user-closing-reader').expect(403);
      expect(query).not.toHaveBeenCalled();
    });

    it('rejects unknown list keys and a non-UUID closing id with 400', async () => {
      await get('/cash-closings').query({ pendingOnly: 'true' }).expect(400);
      await get('/cash-closings/not-a-uuid').expect(400);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('idempotency-key contract', () => {
    it('accepts an exactly-200-character key', async () => {
      const key = 'k'.repeat(200);
      await command('/cash-registers', { name: 'Caja' }, { key }).expect(201);
      expect(execute.mock.calls[0][2]).toBe(key);
    });

    it('rejects an over-long key with 400 and never calls the application', async () => {
      await command(
        '/cash-registers',
        { name: 'Caja' },
        { key: 'k'.repeat(201) },
      ).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a missing or blank key on every command route', async () => {
      const routes: Array<[string, unknown]> = [
        ['/cash-registers', { name: 'Caja' }],
        [
          `/cash-registers/${REGISTER_ID}/sessions`,
          {
            openingCents: 0,
            openingConfirmed: true,
          },
        ],
        [`/cash-sessions/${SESSION_ID}/start-count`, undefined],
        [`/cash-sessions/${SESSION_ID}/declarations`, VALID_COUNT_BODY],
        [`/cash-sessions/${SESSION_ID}/declaration-notes`, { notes: 'x' }],
        [`/cash-sessions/${SESSION_ID}/verifications`, VALID_COUNT_BODY],
        [
          `/cash-sessions/${SESSION_ID}/cash-in`,
          { amountCents: 1, reason: 'x' },
        ],
        [
          `/cash-sessions/${SESSION_ID}/cash-out`,
          { amountCents: 1, reason: 'x' },
        ],
        [`/cash-sessions/${SESSION_ID}/handovers`, VALID_HANDOVER_BODY],
        [`/cash-sessions/${SESSION_ID}/release-drawer`, undefined],
        [`/cash-sessions/${SESSION_ID}/close`, undefined],
        [`/cash-handovers/${HANDOVER_ID}/receive`, { receivedCents: 0 }],
      ];

      for (const [path, body] of routes) {
        await command(path, body, { key: null }).expect(400);
        await command(path, body, { key: '   ' }).expect(400);
      }
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('no arbitrary state mutation endpoints', () => {
    it('has no PATCH/DELETE session mutation route', async () => {
      await patch(`/cash-sessions/${SESSION_ID}`, { status: 'CLOSED' }).expect(
        404,
      );
      await http()
        .delete(`/cash-sessions/${SESSION_ID}`)
        .set('Authorization', 'Bearer user-full')
        .expect(404);
    });

    it('has no DELETE register route and no receipt route yet', async () => {
      await http()
        .delete(`/cash-registers/${REGISTER_ID}`)
        .set('Authorization', 'Bearer user-full')
        .expect(404);
      await http()
        .get(`/cash-closings/${CLOSING_ID}/receipt`)
        .set('Authorization', 'Bearer user-full')
        .expect(404);
    });
  });
});
