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
import type { AppAbility } from '../../auth/authorization/domain/permission';
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
    req.user = { userId: 'u-ana', tenantId: 't-1', isSuperAdmin: false };
    req.ability = build();
    return true;
  }
}

describe('ChatbotRequestCommandsController', () => {
  let app: INestApplication;
  const execute = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatbotRequestCommandsController],
      providers: [
        { provide: ChatbotRequestCommandsService, useValue: { execute } },
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
    canReassign = false;
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
});
