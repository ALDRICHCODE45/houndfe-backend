/**
 * HTTP contract of `POST /chatbot-requests/:id/reply` (unit 10; contract §3.8,
 * §3.10, §12.12): permission metadata, `Idempotency-Key`, `expectedVersion`,
 * the text rules and the error envelope over a mocked application service.
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import request from 'supertest';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
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
  status: 'RESOLVED',
  displayStatus: 'RESOLVED',
  version: 3,
  assignee: { id: 'u-ana', displayName: 'Ana' },
  claimedAt: '2026-11-12T15:00:00.000Z',
  overdueAt: null,
  closedAt: '2026-11-12T16:00:00.000Z',
};

class StubGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user: unknown; ability: AppAbility }>();
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    can('update', 'ChatbotRequest');
    req.user = { userId: 'u-ana', tenantId: 't-1', isSuperAdmin: false };
    req.ability = build();
    return true;
  }
}

describe('POST /chatbot-requests/:id/reply', () => {
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
  beforeEach(() => execute.mockReset().mockResolvedValue(VIEW));

  const post = (body: object, key: string | null = KEY) => {
    const call = request(app.getHttpServer() as Parameters<typeof request>[0])
      .post(`/chatbot-requests/${ID}/reply`)
      .send(body);
    return key === null ? call : call.set('Idempotency-Key', key);
  };

  it('requires read and update:ChatbotRequest (§3.10: update, asignado)', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- only its metadata is read
    const handler = ChatbotRequestCommandsController.prototype.reply;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      ['read', 'ChatbotRequest'],
      ['update', 'ChatbotRequest'],
    ]);
  });

  it('answers 200 {request} and passes the actor, key, version and the cleaned text', async () => {
    const res = await post({
      expectedVersion: 2,
      text: '  Sí, es apto.\u0000  ',
    }).expect(200);
    expect(res.body).toEqual({ request: VIEW });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: ID,
        actorUserId: 'u-ana',
        idempotencyKey: KEY,
        expectedVersion: 2,
        command: { kind: 'reply', text: 'Sí, es apto.' },
      }),
    );
  });

  it.each([
    ['no Idempotency-Key', { expectedVersion: 2, text: 'x' }, null],
    ['a malformed key', { expectedVersion: 2, text: 'x' }, 'nope'],
    ['no expectedVersion', { text: 'x' }, KEY],
    ['expectedVersion 0', { expectedVersion: 0, text: 'x' }, KEY],
    ['no text', { expectedVersion: 2 }, KEY],
    ['blank text', { expectedVersion: 2, text: '   ' }, KEY],
    ['non-string text', { expectedVersion: 2, text: 5 }, KEY],
    [
      'text over 1500 characters',
      { expectedVersion: 2, text: 'a'.repeat(1501) },
      KEY,
    ],
    ['an unknown field', { expectedVersion: 2, text: 'x', tenantId: 't' }, KEY],
    [
      'a smuggled assignee',
      { expectedVersion: 2, text: 'x', assigneeUserId: 'u' },
      KEY,
    ],
  ])(
    '400 VALIDATION_ERROR for %s, without calling the service',
    async (_n, body, key) => {
      const res = await post(body, key).expect(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
      expect(JSON.stringify(res.body)).not.toContain('aaaa');
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('accepts exactly 1500 characters', async () => {
    await post({ expectedVersion: 2, text: 'a'.repeat(1500) }).expect(200);
  });

  it('maps command errors to the typed envelope with current (403 NOT_ASSIGNEE, 409 VERSION_CONFLICT)', async () => {
    const current = {
      version: 5,
      status: 'IN_PROGRESS' as const,
      claimedBy: { id: 'u-luis', displayName: 'Luis' },
    };
    execute.mockRejectedValueOnce(
      new ChatbotRequestCommandError('NOT_ASSIGNEE', 403, current),
    );
    const forbidden = await post({ expectedVersion: 2, text: 'x' }).expect(403);
    expect(forbidden.body).toMatchObject({ code: 'NOT_ASSIGNEE', current });

    execute.mockRejectedValueOnce(
      new ChatbotRequestCommandError('VERSION_CONFLICT', 409, current),
    );
    const conflict = await post({ expectedVersion: 2, text: 'x' }).expect(409);
    expect(conflict.body).toMatchObject({ code: 'VERSION_CONFLICT', current });
  });
});
