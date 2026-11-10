/**
 * HTTP contract of the staff command routes (contract §3.10, §12.12): an
 * in-memory Nest app with the real controller, DTO validation pipe and scoped
 * filter over a mocked application service. Guards are replaced by a stub
 * that sets `request.user`/`request.ability`; their order and permissions are
 * asserted through metadata.
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import request from 'supertest';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  ChatbotRequestCommandError,
  ChatbotRequestCommandsService,
  type ChatbotRequestView,
} from '../application/chatbot-request-commands.service';
import { ChatbotRequestCommandsController } from './chatbot-request-commands.controller';

const ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
const KEY = '5f0b2c1e-6a43-4f7e-9c1d-2b3a4c5d6e7f';
const VIEW: ChatbotRequestView = {
  id: ID,
  folio: 'S-000123',
  kind: 'CLARIFICATION',
  subtype: 'UNKNOWN_QUESTION',
  status: 'IN_PROGRESS',
  displayStatus: 'IN_PROGRESS',
  version: 2,
  assignee: { id: 'u-ana', displayName: 'Ana' },
  claimedAt: '2026-11-10T16:00:00.000Z',
  overdueAt: null,
  closedAt: null,
};

let canReassign = false;
let legacyGrants: [AppActions, AppSubjects][] = [];
let denyPermissions = false;

class StubGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user: unknown; ability: AppAbility }>();
    if (denyPermissions) throw new InsufficientPermissionsError();
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    can('update', 'ChatbotRequest');
    if (canReassign) can('update', 'ChatbotRequestAssignment');
    for (const [action, subject] of legacyGrants) can(action, subject);
    req.user = { userId: 'u-ana', tenantId: 't-1', isSuperAdmin: false };
    req.ability = build();
    return true;
  }
}

describe('ChatbotRequestCommandsController', () => {
  let app: INestApplication;
  const execute = jest.fn();
  const zoneImpact = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatbotRequestCommandsController],
      providers: [
        {
          provide: ChatbotRequestCommandsService,
          useValue: { execute, zoneImpact },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(StubGuard)
      .overrideGuard(TenantContextGuard)
      .useClass(StubGuard)
      .overrideGuard(ActiveUserGuard)
      .useClass(StubGuard)
      .overrideGuard(PermissionsGuard)
      .useClass(StubGuard)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    execute.mockReset().mockResolvedValue(VIEW);
    zoneImpact.mockReset();
    canReassign = false;
    legacyGrants = [];
    denyPermissions = false;
  });

  const post = (path: string, body: object, key: string | null = KEY) => {
    const call = request(app.getHttpServer() as Parameters<typeof request>[0])
      .post(`/chatbot-requests/${ID}/${path}`)
      .send(body);
    return key === null ? call : call.set('Idempotency-Key', key);
  };

  it('declares JwtAuthGuard → TenantContextGuard → ActiveUserGuard → PermissionsGuard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ChatbotRequestCommandsController),
    ).toEqual([
      JwtAuthGuard,
      TenantContextGuard,
      ActiveUserGuard,
      PermissionsGuard,
    ]);
  });

  it.each([
    [
      'claim',
      [
        ['read', 'ChatbotRequest'],
        ['update', 'ChatbotRequest'],
      ],
    ],
    [
      'release',
      [
        ['read', 'ChatbotRequest'],
        ['update', 'ChatbotRequest'],
      ],
    ],
    [
      'cancel',
      [
        ['read', 'ChatbotRequest'],
        ['update', 'ChatbotRequest'],
      ],
    ],
    [
      'resolve',
      [
        ['read', 'ChatbotRequest'],
        ['update', 'ChatbotRequest'],
      ],
    ],
    ['zoneImpact', [['read', 'ChatbotRequest']]],
    [
      'reassign',
      [
        ['read', 'ChatbotRequest'],
        ['update', 'ChatbotRequestAssignment'],
      ],
    ],
  ] as const)('%s requires %j', (method, permissions) => {
    const handler = ChatbotRequestCommandsController.prototype[method];
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(permissions);
  });

  it('claims with the JWT actor, the key and the expected version', async () => {
    const response = await post('claim', { expectedVersion: 1 }).expect(200);

    expect(response.body).toEqual({ request: VIEW });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(execute).toHaveBeenCalledWith({
      requestId: ID,
      actorUserId: 'u-ana',
      actorCanReassign: false,
      actorIsSuperAdmin: false,
      actorCanResolveSubtype: expect.any(Function) as unknown,
      idempotencyKey: KEY,
      expectedVersion: 1,
      command: { kind: 'claim' },
    });
  });

  it('derives actorCanReassign from the ability for release', async () => {
    canReassign = true;
    await post('release', { expectedVersion: 3 }).expect(200);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actorCanReassign: true,
        command: { kind: 'release' },
      }),
    );
  });

  it('forwards reassign and cancel bodies', async () => {
    await post('reassign', {
      expectedVersion: 2,
      toUserId: 'u-luis',
      note: 'turno',
    }).expect(200);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: { kind: 'reassign', toUserId: 'u-luis', note: 'turno' },
      }),
    );

    await post('cancel', {
      expectedVersion: 1,
      reason: 'OTHER',
      note: 'Pregunta repetida en otro canal',
      customerNote: 'Ya le respondimos por teléfono.',
    }).expect(200);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: {
          kind: 'cancel',
          reason: 'OTHER',
          note: 'Pregunta repetida en otro canal',
          customerNote: 'Ya le respondimos por teléfono.',
        },
      }),
    );
  });

  it.each([
    ['a missing Idempotency-Key', 'claim', { expectedVersion: 1 }, null],
    ['a non-UUID Idempotency-Key', 'claim', { expectedVersion: 1 }, 'abc'],
    ['a missing expectedVersion', 'claim', {}, KEY],
    ['a zero expectedVersion', 'claim', { expectedVersion: 0 }, KEY],
    ['an unknown field', 'claim', { expectedVersion: 1, tenantId: 'x' }, KEY],
    [
      'an unknown cancel reason',
      'cancel',
      { expectedVersion: 1, reason: 'X' },
      KEY,
    ],
    [
      'a note over 500 characters',
      'cancel',
      { expectedVersion: 1, reason: 'OTHER', note: 'x'.repeat(501) },
      KEY,
    ],
    ['a reassign without toUserId', 'reassign', { expectedVersion: 1 }, KEY],
  ])('answers 400 VALIDATION_ERROR for %s', async (_case, path, body, key) => {
    const response = await post(path, body, key).expect(400);
    expect(response.body).toEqual({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: expect.any(String) as string,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers 409 with the current row for a typed conflict', async () => {
    const current = {
      version: 5,
      status: 'IN_PROGRESS' as const,
      claimedBy: { id: 'u-luis', displayName: 'Luis' },
    };
    execute.mockRejectedValue(
      new ChatbotRequestCommandError('REQUEST_CLAIMED_BY_OTHER', 409, current),
    );

    const response = await post('claim', { expectedVersion: 4 }).expect(409);
    expect(response.body).toEqual({
      statusCode: 409,
      code: 'REQUEST_CLAIMED_BY_OTHER',
      message: expect.any(String) as string,
      current,
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['NOT_FOUND', 404],
    ['NOT_ASSIGNEE', 403],
    ['CANCEL_NOT_ALLOWED', 422],
    ['CANCEL_NOT_ALLOWED', 409],
    ['IDEMPOTENCY_CONFLICT', 409],
    ['USER_NOT_ASSIGNABLE', 422],
  ] as const)('maps %s to %i', async (code, status) => {
    execute.mockRejectedValue(new ChatbotRequestCommandError(code, status));
    const response = await post('claim', { expectedVersion: 1 }).expect(status);
    expect(response.body).toEqual({
      statusCode: status,
      code,
      message: expect.any(String) as string,
    });
  });

  it('answers 403 INSUFFICIENT_PERMISSIONS when a permission is missing', async () => {
    denyPermissions = true;
    const response = await post('claim', { expectedVersion: 1 }).expect(403);
    expect(response.body).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });

  it('hides unexpected failures behind 500 INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('connection lost: secret detail'));
    const response = await post('claim', { expectedVersion: 1 }).expect(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });

  describe('resolve (unit 3)', () => {
    const lastCommand = () =>
      (
        execute.mock.lastCall as [{ command: unknown; expectedVersion: number }]
      )[0];

    it.each([
      [
        'a restock estimate',
        { action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 7 },
        { type: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 7 },
      ],
      [
        'an unavailable restock',
        { action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE' },
        { type: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE' },
      ],
      [
        'an expiration text',
        { action: 'PROVIDE_EXPIRATION_TEXT', expirationText: 'Dic 2026' },
        { type: 'PROVIDE_EXPIRATION_TEXT', expirationText: 'Dic 2026' },
      ],
      [
        'an unavailable expiration',
        { action: 'REPORT_EXPIRATION_UNAVAILABLE' },
        { type: 'REPORT_EXPIRATION_UNAVAILABLE' },
      ],
      [
        'a zone approval',
        {
          action: 'APPROVE_DELIVERY_ZONE',
          zoneType: 'SURCHARGE',
          surchargeCents: 5000,
          etaDays: 3,
          expectedZoneSetVersion: 7,
        },
        {
          type: 'APPROVE_DELIVERY_ZONE',
          settings: { type: 'SURCHARGE', surchargeCents: 5000, etaDays: 3 },
          expectedZoneSetVersion: 7,
        },
      ],
      [
        'a zone rejection',
        { action: 'REJECT_DELIVERY_ZONE', expectedZoneSetVersion: 2 },
        { type: 'REJECT_DELIVERY_ZONE', expectedZoneSetVersion: 2 },
      ],
      [
        'a receipt confirmation',
        { action: 'CONFIRM_RECEIPT', amountCents: 12000 },
        { type: 'CONFIRM_RECEIPT', amountCents: 12000 },
      ],
      [
        'a receipt rejection',
        {
          action: 'REJECT_RECEIPT',
          reason: 'borroso',
          customerReason: ' Envíanos una foto más clara. ',
        },
        {
          type: 'REJECT_RECEIPT',
          reason: 'borroso',
          customerReason: 'Envíanos una foto más clara.',
        },
      ],
    ])('parses %s', async (_case, body, action) => {
      await post('resolve', { expectedVersion: 3, ...body }).expect(200);
      expect(lastCommand()).toMatchObject({
        expectedVersion: 3,
        command: { kind: 'resolve', action },
      });
    });

    it.each([
      ['an unknown action', { action: 'NOPE' }],
      ['a missing action', {}],
      [
        'a client-sent resolutionRequestId',
        {
          action: 'REPORT_EXPIRATION_UNAVAILABLE',
          resolutionRequestId: KEY,
        },
      ],
      [
        'restockDays on the negative restock action',
        { action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE', restockDays: 1 },
      ],
      [
        'restockDays out of range',
        { action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 400 },
      ],
      [
        'a zone action without expectedZoneSetVersion',
        { action: 'REJECT_DELIVERY_ZONE' },
      ],
      [
        'a zone approval with an extra key',
        {
          action: 'APPROVE_DELIVERY_ZONE',
          zoneType: 'FREE',
          etaDays: 2,
          expectedZoneSetVersion: 1,
          tenantId: 'x',
        },
      ],
      [
        'a receipt confirmation of 0',
        { action: 'CONFIRM_RECEIPT', amountCents: 0 },
      ],
      [
        'a receipt rejection without customerReason',
        { action: 'REJECT_RECEIPT', reason: 'borroso' },
      ],
      [
        'a customerReason over 300 characters',
        {
          action: 'REJECT_RECEIPT',
          reason: 'borroso',
          customerReason: 'x'.repeat(301),
        },
      ],
    ])('answers 400 VALIDATION_ERROR for %s', async (_case, body) => {
      const response = await post('resolve', {
        expectedVersion: 1,
        ...body,
      }).expect(400);
      expect(response.body).toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it('requires the Idempotency-Key and expectedVersion', async () => {
      await post('resolve', { action: 'REPORT_EXPIRATION_UNAVAILABLE' }).expect(
        400,
      );
      await post(
        'resolve',
        { expectedVersion: 1, action: 'REPORT_EXPIRATION_UNAVAILABLE' },
        null,
      ).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('tells the service what the JWT ability may resolve, per subtype', async () => {
      const resolvable = async () => {
        await post('resolve', {
          expectedVersion: 1,
          action: 'REPORT_EXPIRATION_UNAVAILABLE',
        }).expect(200);
        const call = (
          execute.mock.lastCall as [
            { actorCanResolveSubtype: (subtype: string) => boolean },
          ]
        )[0];
        return [
          'RESTOCK',
          'EXPIRATION',
          'DELIVERY_ZONE',
          'TRANSFER_RECEIPT',
        ].map((subtype) => call.actorCanResolveSubtype(subtype));
      };

      // Cashier-like: read + update:ChatbotRequest only.
      expect(await resolvable()).toEqual([false, false, false, false]);

      legacyGrants = [
        ['update', 'HumanDecision'],
        ['validate', 'DeliveryZone'],
      ];
      expect(await resolvable()).toEqual([true, true, true, false]);

      legacyGrants.push(['update', 'ReceiptEvidence']);
      expect(await resolvable()).toEqual([true, true, true, true]);
    });

    it('maps INSUFFICIENT_PERMISSIONS from the service to 403 with no current', async () => {
      execute.mockRejectedValue(
        new ChatbotRequestCommandError('INSUFFICIENT_PERMISSIONS', 403),
      );
      const response = await post('resolve', {
        expectedVersion: 1,
        action: 'REPORT_EXPIRATION_UNAVAILABLE',
      }).expect(403);
      expect(response.body).toEqual({
        statusCode: 403,
        code: 'INSUFFICIENT_PERMISSIONS',
        message: expect.any(String) as string,
      });
    });

    it('answers 409 ZONE_SET_CHANGED with the new zoneImpact', async () => {
      const current = {
        version: 1,
        status: 'NEW' as const,
        claimedBy: null,
        zoneImpact: { requests: 4, customers: 4, setVersion: 8 },
      };
      execute.mockRejectedValue(
        new ChatbotRequestCommandError('ZONE_SET_CHANGED', 409, current),
      );
      const response = await post('resolve', {
        expectedVersion: 1,
        action: 'REJECT_DELIVERY_ZONE',
        expectedZoneSetVersion: 7,
      }).expect(409);
      expect(response.body).toMatchObject({
        code: 'ZONE_SET_CHANGED',
        current,
      });
    });
  });

  it('serves GET zone-impact as {requests, customers, setVersion}', async () => {
    const impact = { requests: 4, customers: 3, setVersion: 7 };
    zoneImpact.mockResolvedValue(impact);
    const response = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get(`/chatbot-requests/${ID}/zone-impact`)
      .expect(200);
    expect(response.body).toEqual(impact);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(zoneImpact).toHaveBeenCalledWith(ID);
  });
});
