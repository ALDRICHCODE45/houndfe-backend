/**
 * HTTP contract of the staff read routes (§3.8, §3.10, §12.3): guard order and
 * permissions through metadata, static paths ahead of `:id`, query validation
 * and `no-store`, over a mocked service. The data paths are covered by the
 * PostgreSQL integration spec.
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
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
import { ChatbotRequestReadsService } from '../application/chatbot-request-reads.service';
import { ChatbotRequestReadsController } from './chatbot-request-reads.controller';

const ID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';

class StubGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user: unknown; ability: AppAbility }>();
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    can('read', 'ChatbotRequest');
    req.user = { userId: 'u-ana', tenantId: 't-1', isSuperAdmin: false };
    req.ability = build();
    return true;
  }
}

describe('ChatbotRequestReadsController', () => {
  let app: INestApplication;
  const service = {
    groups: jest.fn(),
    listByCustomer: jest.fn(),
    counts: jest.fn(),
    history: jest.fn(),
    detail: jest.fn(),
    audit: jest.fn(),
    mergeCandidates: jest.fn(),
    assignableUsers: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatbotRequestReadsController],
      providers: [{ provide: ChatbotRequestReadsService, useValue: service }],
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
    for (const fn of Object.values(service))
      fn.mockReset().mockResolvedValue({});
  });

  const get = (path: string) =>
    request(app.getHttpServer() as Parameters<typeof request>[0]).get(path);

  const handlers = () =>
    Object.getOwnPropertyNames(ChatbotRequestReadsController.prototype)
      .map((name) => ({
        name,
        fn: (
          ChatbotRequestReadsController.prototype as unknown as Record<
            string,
            () => void
          >
        )[name],
      }))
      .filter(({ fn }) => Reflect.hasMetadata(METHOD_METADATA, fn));

  it('declares JwtAuthGuard → TenantContextGuard → ActiveUserGuard → PermissionsGuard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ChatbotRequestReadsController),
    ).toEqual([
      JwtAuthGuard,
      TenantContextGuard,
      ActiveUserGuard,
      PermissionsGuard,
    ]);
  });

  it('requires read:ChatbotRequest everywhere, plus update on merge candidates, and sends no-store', () => {
    for (const { name, fn } of handlers()) {
      const required = Reflect.getMetadata(PERMISSIONS_KEY, fn) as string[][];
      if (name === 'assignableUsers') {
        // §3.10: the reassign picker needs only the reassign permission
        expect(required).toEqual([['update', 'ChatbotRequestAssignment']]);
        expect(Reflect.getMetadata(HEADERS_METADATA, fn)).toEqual([
          { name: 'Cache-Control', value: 'no-store' },
        ]);
        continue;
      }
      expect(required[0]).toEqual(['read', 'ChatbotRequest']);
      expect(required.length).toBe(name === 'mergeCandidates' ? 2 : 1);
      if (name === 'mergeCandidates') {
        expect(required[1]).toEqual(['update', 'ChatbotRequest']);
      }
      expect(Reflect.getMetadata(HEADERS_METADATA, fn)).toEqual([
        { name: 'Cache-Control', value: 'no-store' },
      ]);
    }
  });

  it('declares groups, counts and history before :id', () => {
    const paths = handlers().map(({ fn }) =>
      String(Reflect.getMetadata(PATH_METADATA, fn)),
    );
    const idAt = paths.indexOf(':id');
    for (const fixed of ['groups', 'counts', 'history', 'assignable-users']) {
      expect(paths.indexOf(fixed)).toBeLessThan(idAt);
    }
  });

  it('maps the groups query to the service input', async () => {
    const res = await get(
      `/chatbot-requests/groups?status=scheduled&subtype=TALK_TO_HUMAN&assignee=me&overdue=true&windowClosingSoon=false&limit=10&cursor=abc`,
    );
    expect(res.status).toBe(200);
    expect(service.groups).toHaveBeenCalledWith(
      { userId: 'u-ana', ability: expect.anything() as unknown },
      {
        tab: 'scheduled',
        filters: {
          subtype: 'TALK_TO_HUMAN',
          assignee: { kind: 'me' },
          overdue: true,
          windowClosingSoon: false,
        },
        q: undefined,
        cursor: 'abc',
        limit: 10,
      },
    );
  });

  it('passes q to the service and routes assignable-users', async () => {
    await get('/chatbot-requests/groups?q=S-000123');
    expect(service.groups).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ q: 'S-000123' }),
    );
    expect((await get('/chatbot-requests/assignable-users')).status).toBe(200);
    expect(service.assignableUsers).toHaveBeenCalledTimes(1);
    expect(service.detail).not.toHaveBeenCalled();
  });

  it.each([
    ['/chatbot-requests/groups?status=bogus'],
    ['/chatbot-requests/groups?assignee=nobody'],
    ['/chatbot-requests/groups?overdue=maybe'],
    ['/chatbot-requests/groups?limit=51'],
    ['/chatbot-requests/groups?limit=0'],
    [`/chatbot-requests/groups?q=${'x'.repeat(101)}`],
    ['/chatbot-requests/history?q=juan'],
    ['/chatbot-requests'],
    [`/chatbot-requests?customerKey=`],
    ['/chatbot-requests/history?resolvedBy=not-a-uuid'],
    ['/chatbot-requests/history?from=yesterday'],
    ['/chatbot-requests/not-a-uuid'],
    ['/chatbot-requests/not-a-uuid/audit'],
  ])('rejects %s with 400', async (path) => {
    expect((await get(path)).status).toBe(400);
  });

  it('does not read groups, counts, history or assignable-users as an id', async () => {
    for (const path of ['groups', 'counts', 'history', 'assignable-users']) {
      expect((await get(`/chatbot-requests/${path}`)).status).toBe(200);
    }
    expect(service.detail).not.toHaveBeenCalled();
  });

  it('routes the customer list, detail, audit and merge candidates', async () => {
    await get('/chatbot-requests?customerKey=k1.abc&status=resolved&limit=5');
    expect(service.listByCustomer).toHaveBeenCalledWith(expect.anything(), {
      customerKey: 'k1.abc',
      tab: 'resolved',
      cursor: undefined,
      limit: 5,
    });
    await get(`/chatbot-requests/${ID}`);
    expect(service.detail).toHaveBeenCalledWith(expect.anything(), ID);
    await get(`/chatbot-requests/${ID}/audit?limit=7`);
    expect(service.audit).toHaveBeenCalledWith(ID, { limit: 7 });
    await get(`/chatbot-requests/${ID}/merge-candidates`);
    expect(service.mergeCandidates).toHaveBeenCalledWith(ID);
  });
});
