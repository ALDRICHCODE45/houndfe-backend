/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 4, slice 4b — against REAL PostgreSQL: the `q`
 * search of the grouped inbox (incl. the phone-oracle protection),
 * `assignable-users`, `merge` and `link-customer`, end to end through the
 * three staff controllers with stub guards that set the caller's role.
 * Races run on real concurrent transactions.
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { randomUUID } from 'crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { PERMISSIONS_KEY } from '../auth/authorization/decorators/require-permissions.decorator';
import { InsufficientPermissionsError } from '../shared/domain/domain-error';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../auth/authorization/domain/permission';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import {
  CHATBOT_REQUEST_COMMAND_STORE,
  CHATBOT_REQUEST_RESOLVER,
  ChatbotRequestCommandError,
  ChatbotRequestCommandsService,
} from './application/chatbot-request-commands.service';
import {
  CHATBOT_REQUEST_READ_STORE,
  ChatbotRequestReadsService,
  CUSTOMER_KEY_SEALER,
  INBOX_CLOCK,
} from './application/chatbot-request-reads.service';
import {
  CHATBOT_REQUEST_RELATION_STORE,
  ChatbotRequestRelationsService,
} from './application/chatbot-request-relations.service';
import { CustomerKeySealer } from './domain/customer-key-sealer';
import {
  allocateFolio,
  refreshCustomerGroup,
} from './infrastructure/chatbot-request-writes';
import { PrismaChatbotFeedStore } from './infrastructure/prisma-chatbot-feed.store';
import { hashFeedOutcome, parseFeedOutcome } from './domain/chatbot-feed';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';
import { PrismaChatbotRequestRelationStore } from './infrastructure/prisma-chatbot-request-relation.store';
import { ChatbotRequestCommandsController } from './presentation/chatbot-request-commands.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';
import { ChatbotRequestReadsController } from './presentation/chatbot-request-reads.controller';
import { ChatbotRequestRelationsController } from './presentation/chatbot-request-relations.controller';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

type Grant = [AppActions, AppSubjects];
const READ_UPDATE: Grant[] = [
  ['read', 'ChatbotRequest'],
  ['update', 'ChatbotRequest'],
];
const ROLES: Record<string, Grant[]> = {
  manager: [
    ...READ_UPDATE,
    ['update', 'ChatbotRequestAssignment'],
    ['read', 'CustomerPhone'],
    ['validate', 'DeliveryZone'],
  ],
  cashier: READ_UPDATE,
  readOnly: [['read', 'ChatbotRequest']],
};

@Injectable()
class StubGuard implements CanActivate {
  constructor(private readonly cls: ClsService) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user: unknown;
      ability: AppAbility;
    }>();
    const tenantId = req.headers['x-test-tenant'];
    const userId = req.headers['x-test-user'];
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const [action, subject] of ROLES[req.headers['x-test-role']] ?? [])
      can(action, subject);
    req.user = { userId, tenantId, isSuperAdmin: false };
    req.ability = build();
    this.cls.set('tenantId', tenantId);
    this.cls.set('userId', userId);
    return true;
  }
}

@Injectable()
class StubPermissionsGuard extends StubGuard {
  constructor(
    cls: ClsService,
    private readonly reflector: Reflector,
  ) {
    super(cls);
  }
  override canActivate(context: ExecutionContext): boolean {
    super.canActivate(context);
    const required = this.reflector.get<Array<[AppActions, AppSubjects]>>(
      PERMISSIONS_KEY,
      context.getHandler(),
    );
    const { ability } = context
      .switchToHttp()
      .getRequest<{ ability: AppAbility }>();
    for (const [action, subject] of required ?? []) {
      if (!ability.can(action, subject))
        throw new InsufficientPermissionsError();
    }
    return true;
  }
}

const SECRET = 'integration-secret-of-some-length';
const NOW = new Date('2026-11-11T12:00:00.000Z');

describeIfDb(
  'chatbot request relations: q, assignable-users, merge, link-customer (PostgreSQL)',
  () => {
    const prisma = integrationPrisma();
    const sealer = new CustomerKeySealer(SECRET);
    let app: INestApplication;
    let tenantPrisma: TenantPrismaService;
    let cls: ClsService<TenantClsStore>;
    const tenantA: string = randomUUID();
    const tenantB: string = randomUUID();
    const users = { ana: randomUUID(), luis: randomUUID() };
    const extraUsers: string[] = [];
    let seq = 0;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ClsModule.forRoot({ global: true, middleware: { mount: true } }),
          DatabaseModule,
        ],
        controllers: [
          ChatbotRequestReadsController,
          ChatbotRequestCommandsController,
          ChatbotRequestRelationsController,
        ],
        providers: [
          ChatbotRequestHttpFilter,
          ChatbotRequestCommandsService,
          ChatbotRequestRelationsService,
          ChatbotRequestReadsService,
          {
            provide: CHATBOT_REQUEST_COMMAND_STORE,
            useClass: PrismaChatbotRequestCommandStore,
          },
          {
            provide: CHATBOT_REQUEST_RELATION_STORE,
            useClass: PrismaChatbotRequestRelationStore,
          },
          {
            provide: CHATBOT_REQUEST_READ_STORE,
            useClass: PrismaChatbotRequestReadStore,
          },
          { provide: CUSTOMER_KEY_SEALER, useValue: sealer },
          { provide: INBOX_CLOCK, useValue: () => NOW },
          {
            // The wrapped use cases have their own specs. This stand-in only
            // settles the zone row on the command's own transaction, so the
            // feed enqueue that follows a real resolve finds an answer.
            provide: CHATBOT_REQUEST_RESOLVER,
            inject: [TenantPrismaService],
            useFactory: (tenants: TenantPrismaService) => ({
              resolve: async ({
                row,
              }: {
                row: { deliveryZoneRequestId: string | null };
              }) => {
                const db = tenants.getClient();
                const zone = await db.deliveryZoneRequest.findFirstOrThrow({
                  where: { id: row.deliveryZoneRequestId ?? '' },
                });
                // the whole validation, like the real resolve (siblings too)
                await db.deliveryZoneRequest.updateMany({
                  where: { validationId: zone.validationId },
                  data: {
                    status: 'RESOLVED',
                    version: 2,
                    resolutionSource: 'VALIDATION',
                    zoneType: 'DENIED',
                    resolvedAt: new Date(),
                  },
                });
              },
            }),
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
        .useClass(StubPermissionsGuard)
        .compile();
      app = moduleRef.createNestApplication();
      app.useGlobalPipes(createAppValidationPipe());
      await app.init();
      tenantPrisma = moduleRef.get(TenantPrismaService);
      cls = moduleRef.get<ClsService<TenantClsStore>>(ClsService);
      for (const id of [tenantA, tenantB]) {
        await prisma.tenant.create({
          data: { id, name: 'Relaciones', slug: `cr-relations-${id}` },
        });
      }
      for (const [name, id] of Object.entries(users)) {
        await prisma.user.create({
          data: {
            id,
            email: `${id}@relations.test`,
            hashedPassword: 'x',
            name,
          },
        });
      }
    }, 60_000);

    afterAll(async () => {
      await app.close();
      await prisma.tenant.deleteMany({
        where: { id: { in: [tenantA, tenantB] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [...Object.values(users), ...extraUsers] } },
      });
    });

    // -------------------------------------------------------------- helpers

    const as = (
      role: string,
      tenantId: string = tenantA,
      userId: string = users.ana,
    ) => ({
      'x-test-role': role,
      'x-test-tenant': tenantId,
      'x-test-user': userId,
    });
    const http = () =>
      request(app.getHttpServer() as Parameters<typeof request>[0]);
    const get = (path: string, role = 'manager', tenantId: string = tenantA) =>
      http().get(path).set(as(role, tenantId));
    const post = (
      path: string,
      body: object,
      role = 'manager',
      userId: string = users.ana,
      key: string = randomUUID(),
    ) =>
      http()
        .post(path)
        .set(as(role, tenantA, userId))
        .set('Idempotency-Key', key)
        .send(body);

    async function create(
      over: Record<string, unknown> = {},
      tenantId: string = tenantA,
    ): Promise<{ id: string; customerKey: string; folio: number }> {
      const customerKey =
        (over.customerKey as string) ??
        `52552000${String(++seq).padStart(4, '0')}`;
      const row = await cls.runWith(
        { tenantId, userId: 'test', isSuperAdmin: false },
        () =>
          tenantPrisma.runInTransaction(async () => {
            const tx = tenantPrisma.getClient();
            const created = await tx.chatbotRequest.create({
              data: {
                tenantId,
                folio: await allocateFolio(tx, tenantId),
                kind: 'CLARIFICATION',
                subtype: 'UNKNOWN_QUESTION',
                summary: `Pregunta ${seq}`,
                // one conversation per phone unless a test says otherwise
                conversationRef: `wa:${customerKey}`,
                source: 'chatbot',
                sourceRequestId: randomUUID(),
                ...over,
                customerKey,
              } as never,
            });
            await refreshCustomerGroup(tx, tenantId, customerKey);
            return created;
          }),
      );
      return { id: row.id, customerKey, folio: row.folio };
    }

    const stored = (id: string) =>
      prisma.chatbotRequest.findUniqueOrThrow({ where: { id } });
    const events = (requestId: string) =>
      prisma.chatbotRequestEvent.findMany({
        where: { requestId },
        orderBy: [{ version: 'asc' }, { createdAt: 'asc' }],
      });
    const group = (customerKey: string) =>
      prisma.chatbotCustomerGroup.findUnique({
        where: { tenantId_customerKey: { tenantId: tenantA, customerKey } },
      });
    const folioOf = (n: number) => `S-${String(n).padStart(6, '0')}`;
    const heldBy = (userId: string, name: string) => ({
      status: 'IN_PROGRESS',
      assigneeUserId: userId,
      assigneeDisplayName: name,
      claimedAt: new Date(),
    });
    const phoneKey = () => `52553${String(++seq).padStart(7, '0')}`;

    // ------------------------------------------------------------------- q

    describe('q on GET /chatbot-requests/groups', () => {
      let maria: { customerId: string; key: string; folio: number };
      let mariaTwo: { key: string };
      let juan: { key: string };
      let foreign: { key: string };

      beforeAll(async () => {
        const mk = async (
          tenantId: string,
          firstName: string,
          lastName: string | null,
          key: string,
        ) => {
          const customer = await prisma.customer.create({
            data: {
              tenantId,
              firstName,
              lastName,
              phoneCountryCode: '52',
              phone: key.slice(2),
            },
          });
          const request = await create(
            {
              customerKey: key,
              customerId: customer.id,
              phoneCountryCode: '52',
              phone: key.slice(2),
            },
            tenantId,
          );
          return { customerId: customer.id, key, folio: request.folio };
        };
        maria = await mk(tenantA, 'María', 'Pérez Ñandú', '525540010001');
        mariaTwo = await mk(tenantA, 'Mariana', 'Gómez', '525540010002');
        juan = await mk(tenantA, 'Juan', null, '525540020003');
        foreign = await mk(tenantB, 'María', 'Foránea', '525540010009');
      });

      const found = async (q: string, role = 'manager') => {
        const res = await get(
          `/chatbot-requests/groups?q=${encodeURIComponent(q)}&limit=50`,
          role,
        ).expect(200);
        return (res.body.items as Array<{ customerKey: string }>).map(
          (item) => item.customerKey,
        );
      };
      const token = (key: string, tenantId: string = tenantA) =>
        sealer.seal(tenantId, key);

      it('finds an exact folio, any case and padding, for every role', async () => {
        for (const role of ['cashier', 'manager', 'readOnly']) {
          expect(await found(folioOf(maria.folio), role)).toEqual([
            token(maria.key),
          ]);
        }
        expect(await found(`s-${maria.folio}`)).toEqual([token(maria.key)]);
        expect(await found(folioOf(maria.folio + 5000))).toEqual([]);
        // a folio is exact: a prefix of it finds nothing
        expect(await found('S-0000')).toEqual([]);
      });

      it('finds the folio of another sucursal in no case (folios are per tenant)', async () => {
        const other = await prisma.chatbotRequest.findFirstOrThrow({
          where: { tenantId: tenantB, customerKey: foreign.key },
        });
        const sameFolioHere = await prisma.chatbotRequest.findFirst({
          where: { tenantId: tenantA, folio: other.folio },
        });
        const keys = await found(folioOf(other.folio));
        expect(keys).not.toContain(token(foreign.key));
        expect(keys).not.toContain(token(foreign.key, tenantB));
        expect(keys.length).toBe(sameFolioHere ? 1 : 0);
      });

      it('finds by name: case, accent and word-order insensitive, prefix or contains', async () => {
        const both = [token(maria.key), token(mariaTwo.key)].sort();
        expect((await found('maria')).sort()).toEqual(both);
        expect((await found('MARÍA')).sort()).toEqual(both);
        expect((await found('mar')).sort()).toEqual(both);
        expect(await found('nandu')).toEqual([token(maria.key)]);
        expect(await found('ÑANDÚ perez')).toEqual([token(maria.key)]);
        expect(await found('rian')).toEqual([token(mariaTwo.key)]);
        expect(await found('juan')).toEqual([token(juan.key)]);
        expect(await found('zzz')).toEqual([]);
        // LIKE wildcards are literal
        expect(await found('%')).toEqual([]);
        expect(await found('_')).toEqual([]);
      });

      it('never finds a customer of another sucursal by name', async () => {
        expect(await found('Foránea')).toEqual([]);
      });

      it('finds by phone digits (any separators, contains) only with read:CustomerPhone', async () => {
        expect(await found('55 4001-0001')).toEqual([token(maria.key)]);
        expect(await found('40010001')).toEqual([token(maria.key)]);
        expect(await found('+52 (55) 4002')).toEqual([token(juan.key)]);
      });

      it('is no phone oracle: without read:CustomerPhone a number answers exactly like a miss', async () => {
        const miss = await get(
          '/chatbot-requests/groups?q=0000000000',
          'cashier',
        ).expect(200);
        for (const role of ['cashier', 'readOnly']) {
          for (const q of ['5540010001', '40010001', '0001', '+52 55 4001']) {
            const res = await get(
              `/chatbot-requests/groups?q=${encodeURIComponent(q)}`,
              role,
            ).expect(200);
            expect(res.body).toEqual(miss.body);
            expect(res.body).toEqual({ items: [], nextCursor: null });
          }
        }
        // mixed text is a name search and never matches the phone
        expect(await found('maria 0001', 'cashier')).toEqual([]);
      });

      it('keeps pagination and order with q', async () => {
        const everyone = await get(
          '/chatbot-requests/groups?q=mar&limit=1',
        ).expect(200);
        expect(everyone.body.items).toHaveLength(1);
        expect(everyone.body.nextCursor).not.toBeNull();
        const next = await get(
          `/chatbot-requests/groups?q=mar&limit=1&cursor=${everyone.body.nextCursor as string}`,
        ).expect(200);
        expect(next.body.items).toHaveLength(1);
        expect(next.body.nextCursor).toBeNull();
        const all = await found('mar');
        expect([
          everyone.body.items[0].customerKey,
          next.body.items[0].customerKey,
        ]).toEqual(all);
      });

      it('combines with the other filters and with closed tabs', async () => {
        const res = await get(
          '/chatbot-requests/groups?q=maria&subtype=TALK_TO_HUMAN',
        ).expect(200);
        expect(res.body.items).toEqual([]);
        const closedAt = new Date(NOW.getTime() - 3_600_000);
        await create({
          customerKey: maria.key,
          customerId: maria.customerId,
          status: 'RESOLVED',
          resolvedAt: closedAt,
          closedAt,
          resolvedByActorId: users.luis,
          resolvedByDisplayName: 'Luis',
        });
        const resolved = await get(
          '/chatbot-requests/groups?q=maria&status=resolved',
        ).expect(200);
        expect(
          resolved.body.items.map(
            (i: { customerKey: string }) => i.customerKey,
          ),
        ).toEqual([token(maria.key)]);
      });

      it('rejects q on history and a q longer than 100 characters', async () => {
        await get('/chatbot-requests/history?q=maria').expect(400);
        await get(`/chatbot-requests/groups?q=${'a'.repeat(101)}`).expect(400);
      });
    });

    // ------------------------------------------------------ assignable-users

    describe('GET /chatbot-requests/assignable-users', () => {
      const fixtures: Record<string, string> = {};

      beforeAll(async () => {
        const permission = (action: string, subject = 'ChatbotRequest') =>
          prisma.permission.upsert({
            where: { subject_action: { subject, action } },
            update: {},
            create: { subject, action },
          });
        const [read, update, manage] = [
          await permission('read'),
          await permission('update'),
          await permission('manage'),
        ];
        const role = (
          tenantId: string,
          name: string,
          permissionIds: string[],
        ) =>
          prisma.role.create({
            data: {
              tenantId,
              name: `${name} ${tenantId}`,
              permissions: {
                create: permissionIds.map((permissionId) => ({ permissionId })),
              },
            },
          });
        const roles = {
          both: await role(tenantA, 'ambos', [read.id, update.id]),
          readOnly: await role(tenantA, 'lee', [read.id]),
          updateOnly: await role(tenantA, 'actualiza', [update.id]),
          manage: await role(tenantA, 'maneja', [manage.id]),
          foreign: await role(tenantB, 'ambos-b', [read.id, update.id]),
        };
        const member = async (
          label: string,
          name: string,
          memberships: Array<[string, string]>,
          isActive = true,
        ) => {
          const id = randomUUID();
          extraUsers.push(id);
          fixtures[label] = id;
          await prisma.user.create({
            data: {
              id,
              email: `${label}-${id}@assignable.test`,
              hashedPassword: 'x',
              name,
              isActive,
            },
          });
          for (const [tenantId, roleId] of memberships) {
            await prisma.tenantMembership.create({
              data: { userId: id, tenantId, roleId },
            });
          }
        };
        await member('single', 'Beto Único', [[tenantA, roles.both.id]]);
        // read from one role, update from another: CASL merges them
        await member('merged', 'Carla Mezcla', [
          [tenantA, roles.readOnly.id],
          [tenantA, roles.updateOnly.id],
        ]);
        await member('manage', 'Dani Maneja', [[tenantA, roles.manage.id]]);
        await member('readOnly', 'Eva Lee', [[tenantA, roles.readOnly.id]]);
        await member('updateOnly', 'Fer Actualiza', [
          [tenantA, roles.updateOnly.id],
        ]);
        await member(
          'inactive',
          'Gus Inactivo',
          [[tenantA, roles.both.id]],
          false,
        );
        await member('otherTenant', 'Hugo Otro', [[tenantB, roles.foreign.id]]);
        // a member of both tenants shows up only where the grants are
        await member('both', 'Iris Ambas', [
          [tenantA, roles.readOnly.id],
          [tenantB, roles.foreign.id],
        ]);
      });

      const picker = async (tenantId: string = tenantA, role = 'manager') => {
        const res = await get(
          '/chatbot-requests/assignable-users',
          role,
          tenantId,
        ).expect(200);
        return res.body as { items: Array<Record<string, unknown>> };
      };

      it('lists active members with read+update, merged across roles, of this tenant only', async () => {
        const ids = (await picker()).items.map((item) => item.id);
        expect(ids).toEqual(
          expect.arrayContaining([
            fixtures.single,
            fixtures.merged,
            fixtures.manage,
          ]),
        );
        for (const excluded of [
          'readOnly',
          'updateOnly',
          'inactive',
          'otherTenant',
          'both',
        ]) {
          expect(ids).not.toContain(fixtures[excluded]);
        }
        const inB = (await picker(tenantB)).items.map((item) => item.id);
        // Iris is read-only here but read + update in B: assignable in B only
        expect(inB).toEqual(
          expect.arrayContaining([fixtures.otherTenant, fixtures.both]),
        );
        expect(inB).not.toContain(fixtures.single);
      });

      it('returns {id, displayName} only, sorted by name', async () => {
        const { items } = await picker();
        for (const item of items) {
          expect(Object.keys(item).sort()).toEqual(['displayName', 'id']);
        }
        const ours = items.filter((item) =>
          [fixtures.single, fixtures.merged, fixtures.manage].includes(
            item.id as string,
          ),
        );
        expect(ours.map((item) => item.displayName)).toEqual([
          'Beto Único',
          'Carla Mezcla',
          'Dani Maneja',
        ]);
        expect(JSON.stringify(items)).not.toContain('@');
      });

      it('requires update:ChatbotRequestAssignment', async () => {
        await get('/chatbot-requests/assignable-users', 'cashier').expect(403);
        await get('/chatbot-requests/assignable-users', 'readOnly').expect(403);
      });

      it('is exactly the set `reassign` accepts', async () => {
        const listed = new Set(
          (await picker()).items.map((item) => item.id as string),
        );
        const request = await create(heldBy(users.luis, 'Luis'));
        for (const [label, id] of Object.entries(fixtures)) {
          const res = await post(
            `/chatbot-requests/${request.id}/reassign`,
            { expectedVersion: 1, toUserId: id },
            'manager',
          );
          const refused = res.body.code === 'USER_NOT_ASSIGNABLE';
          expect({ label, refused }).toEqual({
            label,
            refused: !listed.has(id),
          });
        }
      });
    });

    // ----------------------------------------------------------------- merge

    describe('POST /chatbot-requests/:id/merge', () => {
      const pair = async (
        sourceOver: Record<string, unknown> = {},
        targetOver: Record<string, unknown> = {},
      ) => {
        const customerKey = phoneKey();
        const source = await create({ customerKey, ...sourceOver });
        const target = await create({ customerKey, ...targetOver });
        return { source, target, customerKey };
      };
      const merge = (
        sourceId: string,
        targetId: string,
        over: Record<string, unknown> = {},
        role = 'cashier',
        userId: string = users.ana,
        key?: string,
      ) =>
        post(
          `/chatbot-requests/${sourceId}/merge`,
          {
            expectedVersion: 1,
            intoRequestId: targetId,
            intoExpectedVersion: 1,
            ...over,
          },
          role,
          userId,
          key,
        );

      it('closes the source as SUPERSEDED, audits both, keeps the target version, refreshes the group', async () => {
        const { source, target, customerKey } = await pair();
        expect(await group(customerKey)).toMatchObject({ openCount: 2 });
        const res = await merge(source.id, target.id).expect(200);

        expect(res.body.request).toMatchObject({
          id: source.id,
          status: 'CANCELLED',
          version: 2,
        });
        expect(await stored(source.id)).toMatchObject({
          status: 'CANCELLED',
          cancelReason: 'SUPERSEDED',
          staffCancelReason: null,
          version: 2,
        });
        expect(await stored(target.id)).toMatchObject({
          status: 'NEW',
          version: 1,
        });
        expect(await group(customerKey)).toMatchObject({ openCount: 1 });
        const [sourceEvent] = await events(source.id);
        expect(sourceEvent).toMatchObject({
          type: 'MERGED',
          actorKind: 'USER',
          actorId: users.ana,
          fromStatus: 'NEW',
          toStatus: 'CANCELLED',
          version: 2,
          data: {
            role: 'SOURCE',
            intoRequestId: target.id,
            intoFolio: target.folio,
          },
        });
        const [targetEvent] = await events(target.id);
        expect(targetEvent).toMatchObject({
          type: 'MERGED',
          fromStatus: 'NEW',
          toStatus: 'NEW',
          version: 1,
          data: {
            role: 'TARGET',
            sourceRequestId: source.id,
            sourceFolio: source.folio,
          },
        });
      });

      it('enqueues one request.merged feed item for the source, with ids and the conversation only', async () => {
        const { source, target, customerKey } = await pair();
        await merge(source.id, target.id).expect(200);
        const items = await prisma.chatbotFeedItem.findMany({
          where: { requestId: { in: [source.id, target.id] } },
        });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          tenantId: tenantA,
          requestId: source.id,
          type: 'request.merged',
          conversationRef: `wa:${customerKey}`,
          outcome: null,
          ackedAt: null,
          payload: {
            requestId: source.id,
            intoRequestId: target.id,
            conversationRef: `wa:${customerKey}`,
          },
        });
        // nothing else leaves in the payload (no phone, no text)
        expect(Object.keys(items[0].payload as object).sort()).toEqual([
          'conversationRef',
          'intoRequestId',
          'requestId',
        ]);
      });

      it('request.merged accepts only STALE; every other outcome is 422 OUTCOME_NOT_ALLOWED', async () => {
        const { source, target } = await pair();
        await merge(source.id, target.id).expect(200);
        const item = await prisma.chatbotFeedItem.findFirstOrThrow({
          where: { requestId: source.id },
        });
        const feed = new PrismaChatbotFeedStore(
          tenantPrisma,
          prisma as unknown as PrismaService,
        );
        const ack = (body: Record<string, unknown>) => {
          const input = parseFeedOutcome({
            attemptId: randomUUID(),
            ...body,
          });
          return cls.runWith(
            { tenantId: tenantA, userId: 'bot', isSuperAdmin: false },
            () =>
              feed.recordOutcome(
                item.deliveryId,
                'cred-1',
                input,
                hashFeedOutcome(input),
              ),
          );
        };
        const at = new Date().toISOString();
        const code = (promise: Promise<unknown>) =>
          promise.then(
            () => 'OK',
            (error: unknown) =>
              error instanceof ChatbotRequestCommandError
                ? `${error.httpStatus} ${error.code}`
                : String(error),
          );
        for (const body of [
          {
            outcome: 'PROVIDER_ACCEPTED',
            providerMessageId: 'w1',
            attemptedAt: at,
          },
          { outcome: 'DELIVERY_UNKNOWN', attemptedAt: at },
          { outcome: 'DEFERRED_WINDOW_CLOSED', attemptedAt: at },
          { outcome: 'DEFERRED_HUMAN_SESSION', attemptedAt: at },
        ]) {
          expect(await code(ack(body))).toBe('422 OUTCOME_NOT_ALLOWED');
        }
        // nothing was recorded by the refusals
        expect(
          await prisma.chatbotFeedItem.findUniqueOrThrow({
            where: { cursor: item.cursor },
          }),
        ).toMatchObject({ outcome: null, ackedAt: null });
        expect(await code(ack({ outcome: 'STALE' }))).toBe('OK');
        expect(
          await prisma.chatbotFeedItem.findUniqueOrThrow({
            where: { cursor: item.cursor },
          }),
        ).toMatchObject({ outcome: 'STALE' });
      });

      it('rejected merges leave no feed item behind', async () => {
        const key = phoneKey();
        const source = await create({ customerKey: key });
        const otherConversation = await create({
          customerKey: key,
          conversationRef: 'wa:other',
        });
        const noConversation = await create({
          customerKey: key,
          conversationRef: null,
        });
        const sameConversation = await create({ customerKey: key });
        for (const target of [otherConversation, noConversation]) {
          const res = await merge(source.id, target.id);
          expect(res.status).toBe(409);
          expect(res.body).toMatchObject({
            code: 'MERGE_NOT_ALLOWED',
            intoRequestId: target.id,
          });
        }
        // 403 for a held source without the permission, 409 for a stale version
        await post(`/chatbot-requests/${sameConversation.id}/claim`, {
          expectedVersion: 1,
        }).set('x-test-user', users.luis);
        await merge(sameConversation.id, source.id, {}, 'cashier').expect(403);
        await merge(source.id, sameConversation.id, {
          expectedVersion: 9,
        }).expect(409);
        expect(
          await prisma.chatbotFeedItem.count({
            where: {
              requestId: {
                in: [source.id, otherConversation.id, noConversation.id],
              },
            },
          }),
        ).toBe(0);
        expect(await stored(source.id)).toMatchObject({
          status: 'NEW',
          version: 1,
        });
      });

      it('refuses a merge across conversations or without one with 409 before any lock, writing nothing', async () => {
        for (const over of [
          { conversationRef: 'wa:other' },
          { conversationRef: null },
        ]) {
          const { source, target } = await pair({}, over);
          const before = [await stored(source.id), await stored(target.id)];
          const res = await merge(source.id, target.id);
          expect(res.status).toBe(409);
          expect(res.body.code).toBe('MERGE_NOT_ALLOWED');
          expect([await stored(source.id), await stored(target.id)]).toEqual(
            before,
          );
          expect(await events(source.id)).toHaveLength(0);
        }
        // a source with no conversation, whatever the target has
        const none = { conversationRef: null };
        const { source, target } = await pair(none, none);
        expect((await merge(source.id, target.id)).status).toBe(409);
      });

      it('a source held by someone else: 403 NOT_ASSIGNEE without the assignment permission, 200 for the holder and for a reassigner', async () => {
        const held = await pair(heldBy(users.luis, 'Luis'));
        const refused = await merge(
          held.source.id,
          held.target.id,
          {},
          'cashier',
        );
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({
          code: 'NOT_ASSIGNEE',
          current: { claimedBy: { id: users.luis } },
        });
        expect(await stored(held.source.id)).toMatchObject({
          status: 'IN_PROGRESS',
          version: 1,
        });
        expect(await events(held.source.id)).toHaveLength(0);
        // the holder, a cashier
        await merge(
          held.source.id,
          held.target.id,
          {},
          'cashier',
          users.luis,
        ).expect(200);
        // a user with update:ChatbotRequestAssignment (manager)
        const other = await pair(heldBy(users.luis, 'Luis'));
        await merge(other.source.id, other.target.id, {}, 'manager').expect(
          200,
        );
        // who holds the TARGET does not matter
        const heldTarget = await pair({}, heldBy(users.luis, 'Luis'));
        await merge(
          heldTarget.source.id,
          heldTarget.target.id,
          {},
          'cashier',
        ).expect(200);
      });

      it("tells the source's assignee when someone else merged it, never the merger", async () => {
        const { source, target } = await pair(heldBy(users.luis, 'Luis'));
        await merge(source.id, target.id, {}, 'manager').expect(200);
        const notices = await prisma.outboxEvent.findMany({
          where: {
            tenantId: tenantA,
            eventType: 'chatbot_request.notify',
            aggregateId: source.id,
          },
        });
        expect(notices.map((n) => n.payload)).toEqual([
          expect.objectContaining({
            type: 'REQUEST_CANCELLED',
            recipientUserId: users.luis,
            actorUserId: users.ana,
            cause: 'MERGED',
          }),
        ]);
        const own = await pair(heldBy(users.ana, 'Ana'));
        await merge(own.source.id, own.target.id).expect(200);
        expect(
          await prisma.outboxEvent.count({
            where: { aggregateId: own.source.id },
          }),
        ).toBe(0);
      });

      it('works for TALK_TO_HUMAN and COMPLAINT too', async () => {
        for (const subtype of ['TALK_TO_HUMAN', 'COMPLAINT']) {
          const over = { kind: 'CONVERSATION', subtype };
          const { source, target } = await pair(over, over);
          await merge(source.id, target.id).expect(200);
        }
      });

      it('refuses with 422 MERGE_NOT_ALLOWED and changes nothing', async () => {
        const refusals: Array<
          [string, () => Promise<{ s: string; t: string }>]
        > = [
          [
            'another subtype',
            async () => {
              const key = phoneKey();
              const s = await create({ customerKey: key });
              const t = await create({
                customerKey: key,
                kind: 'CONVERSATION',
                subtype: 'COMPLAINT',
              });
              return { s: s.id, t: t.id };
            },
          ],
          [
            'another customer',
            async () => {
              // same conversation, so only the customer rule can refuse
              const s = await create({
                customerKey: phoneKey(),
                conversationRef: 'wa:shared',
              });
              const t = await create({
                customerKey: phoneKey(),
                conversationRef: 'wa:shared',
              });
              return { s: s.id, t: t.id };
            },
          ],
          [
            'a closed target',
            async () => {
              const key = phoneKey();
              const s = await create({ customerKey: key });
              const at = new Date();
              const t = await create({
                customerKey: key,
                status: 'CANCELLED',
                cancelledAt: at,
                closedAt: at,
                cancelReason: 'CUSTOMER_WITHDREW',
              });
              return { s: s.id, t: t.id };
            },
          ],
          [
            'itself',
            async () => {
              const s = await create({ customerKey: phoneKey() });
              return { s: s.id, t: s.id };
            },
          ],
        ];
        for (const [label, setup] of refusals) {
          const { s, t } = await setup();
          const before = [await stored(s), await stored(t)];
          const res = await merge(s, t);
          expect({ label, status: res.status, code: res.body.code }).toEqual({
            label,
            status: 422,
            code: 'MERGE_NOT_ALLOWED',
          });
          expect(res.body.current).toMatchObject({ version: 1 });
          expect([await stored(s), await stored(t)]).toEqual(before);
          expect(await events(s)).toHaveLength(0);
        }
      });

      it('refuses wrapped subtypes (restock, zone) without locking or writing', async () => {
        const key = phoneKey();
        const decision = () =>
          prisma.humanDecision.create({
            data: {
              tenantId: tenantA,
              source: 'chatbot',
              sourceRequestId: randomUUID(),
              canonicalRequestHash: 'h',
              submittedCredentialId: 'cred',
              branchId: tenantA,
              branchName: 'Centro',
              productId: randomUUID(),
              productName: 'Croquetas',
              requestedQuantity: 1,
            },
          });
        const a = await create({
          customerKey: key,
          kind: 'DECISION',
          subtype: 'RESTOCK',
          humanDecisionId: (await decision()).id,
        });
        const b = await create({
          customerKey: key,
          kind: 'DECISION',
          subtype: 'RESTOCK',
          humanDecisionId: (await decision()).id,
        });
        const res = await merge(a.id, b.id);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('MERGE_NOT_ALLOWED');
        expect(await stored(a.id)).toMatchObject({ status: 'NEW', version: 1 });
        expect(await events(a.id)).toHaveLength(0);
      });

      it('answers 404 for unknown ids and for a request of another sucursal', async () => {
        const { source } = await pair();
        const foreign = await create({ customerKey: phoneKey() }, tenantB);
        await merge(source.id, randomUUID()).expect(404);
        await merge(randomUUID(), source.id).expect(404);
        const intoForeign = await merge(source.id, foreign.id);
        expect(intoForeign.status).toBe(404);
        expect(await stored(source.id)).toMatchObject({ status: 'NEW' });
      });

      it('answers 409 VERSION_CONFLICT with the current of the side that moved', async () => {
        const { source, target } = await pair();
        const staleSource = await merge(source.id, target.id, {
          expectedVersion: 7,
        }).expect(409);
        expect(staleSource.body).toMatchObject({
          code: 'VERSION_CONFLICT',
          current: { version: 1, status: 'NEW' },
        });
        expect(staleSource.body.intoRequestId).toBeUndefined();
        await post(`/chatbot-requests/${target.id}/claim`, {
          expectedVersion: 1,
        }).expect(200);
        const staleTarget = await merge(source.id, target.id).expect(409);
        expect(staleTarget.body).toMatchObject({
          code: 'VERSION_CONFLICT',
          intoRequestId: target.id,
          current: {
            version: 2,
            status: 'IN_PROGRESS',
            claimedBy: { id: users.ana },
          },
        });
        expect(await stored(source.id)).toMatchObject({ status: 'NEW' });
      });

      it('answers 409 REQUEST_CLOSED for a closed source', async () => {
        const { source, target } = await pair();
        await merge(source.id, target.id).expect(200);
        const again = await merge(source.id, target.id, {}, 'cashier');
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('REQUEST_CLOSED');
      });

      it('replays the same key and body with one event; another body is IDEMPOTENCY_CONFLICT', async () => {
        const { source, target } = await pair();
        const key = randomUUID();
        const first = await merge(
          source.id,
          target.id,
          {},
          'cashier',
          users.ana,
          key,
        ).expect(200);
        const again = await merge(
          source.id,
          target.id,
          {},
          'cashier',
          users.ana,
          key,
        ).expect(200);
        expect(again.body).toEqual(first.body);
        expect(await events(source.id)).toHaveLength(1);
        expect(await events(target.id)).toHaveLength(1);
        const other = await merge(
          source.id,
          target.id,
          { intoExpectedVersion: 2 },
          'cashier',
          users.ana,
          key,
        );
        expect(other.status).toBe(409);
        expect(other.body.code).toBe('IDEMPOTENCY_CONFLICT');
      });

      it('requires read + update:ChatbotRequest', async () => {
        const { source, target } = await pair();
        await merge(source.id, target.id, {}, 'readOnly').expect(403);
        expect(await stored(source.id)).toMatchObject({ status: 'NEW' });
      });

      it('A→B and B→A at once: no deadlock, exactly one wins, in every round', async () => {
        for (let round = 0; round < 12; round++) {
          const { source: a, target: b } = await pair();
          const [ab, ba] = await Promise.all([
            merge(a.id, b.id),
            merge(b.id, a.id),
          ]);
          expect([ab.status, ba.status].sort()).toEqual([200, 422]);
          const loser = ab.status === 200 ? ba : ab;
          expect(loser.body.code).toBe('MERGE_NOT_ALLOWED');
          const [ra, rb] = [await stored(a.id), await stored(b.id)];
          expect([ra.status, rb.status].sort()).toEqual(['CANCELLED', 'NEW']);
          // the closed one is the source of the winning call
          expect((ab.status === 200 ? ra : rb).status).toBe('CANCELLED');
        }
      });

      it('two sources merged into one target at once both win (the target version does not move)', async () => {
        const customerKey = phoneKey();
        const target = await create({ customerKey });
        const s1 = await create({ customerKey });
        const s2 = await create({ customerKey });
        const [r1, r2] = await Promise.all([
          merge(s1.id, target.id),
          merge(s2.id, target.id),
        ]);
        expect([r1.status, r2.status]).toEqual([200, 200]);
        expect(await stored(target.id)).toMatchObject({
          status: 'NEW',
          version: 1,
        });
        expect(await events(target.id)).toHaveLength(2);
        expect(await group(customerKey)).toMatchObject({ openCount: 1 });
      });

      it('merge vs claim of the source: one consistent winner', async () => {
        for (let round = 0; round < 6; round++) {
          const { source, target } = await pair();
          const [m, c] = await Promise.all([
            merge(source.id, target.id),
            post(`/chatbot-requests/${source.id}/claim`, {
              expectedVersion: 1,
            }),
          ]);
          expect([m.status, c.status].filter((s) => s === 200)).toHaveLength(1);
          const row = await stored(source.id);
          expect(row.version).toBe(2);
          expect(row.status).toBe(
            m.status === 200 ? 'CANCELLED' : 'IN_PROGRESS',
          );
        }
      });

      it('MERGE appears in allowedActions and merge-candidates only while there is a candidate', async () => {
        const { source, target } = await pair();
        for (const role of ['manager', 'cashier']) {
          const detail = await get(`/chatbot-requests/${source.id}`, role);
          expect(detail.body.allowedActions).toContain('MERGE');
        }
        const readOnly = await get(
          `/chatbot-requests/${source.id}`,
          'readOnly',
        );
        expect(readOnly.body.allowedActions).toEqual([]);
        const candidates = await get(
          `/chatbot-requests/${source.id}/merge-candidates`,
        ).expect(200);
        expect(candidates.body.items.map((r: { id: string }) => r.id)).toEqual([
          target.id,
        ]);
        await merge(source.id, target.id).expect(200);
        const alone = await get(`/chatbot-requests/${target.id}`);
        expect(alone.body.allowedActions).not.toContain('MERGE');
        const closedSource = await get(`/chatbot-requests/${source.id}`);
        expect(closedSource.body.allowedActions).toEqual([]);
      });

      it('MERGE is never offered on a wrapped subtype', async () => {
        const key = phoneKey();
        const decision = await prisma.humanDecision.create({
          data: {
            tenantId: tenantA,
            source: 'chatbot',
            sourceRequestId: randomUUID(),
            canonicalRequestHash: 'h',
            submittedCredentialId: 'cred',
            branchId: tenantA,
            branchName: 'Centro',
            productId: randomUUID(),
            productName: 'Croquetas',
            requestedQuantity: 1,
          },
        });
        const restock = await create({
          customerKey: key,
          kind: 'DECISION',
          subtype: 'RESTOCK',
          humanDecisionId: decision.id,
        });
        await create({ customerKey: key });
        const detail = await get(`/chatbot-requests/${restock.id}`);
        expect(detail.body.allowedActions).not.toContain('MERGE');
      });
    });

    // ---------------------------------------------------------- link-customer

    describe('POST /chatbot-requests/:id/link-customer', () => {
      /** An ambiguous key: two customers share the phone (R1), plus requests. */
      async function ambiguous() {
        const key = phoneKey();
        const national = key.slice(2);
        const mk = (firstName: string, countryCode = '52') =>
          prisma.customer.create({
            data: {
              tenantId: tenantA,
              firstName,
              lastName: 'Duplicada',
              phoneCountryCode: countryCode,
              phone: national,
            },
          });
        // the second one is stored in WhatsApp's 521 form: still the same key
        const [c1, c2] = [await mk('Rosa'), await mk('Rosita', '521')];
        const over = {
          customerKey: key,
          ambiguousCustomer: true,
          phoneCountryCode: '52',
          phone: national,
        };
        const anchor = await create(over);
        const sibling = await create(over);
        const at = new Date(NOW.getTime() - 3_600_000);
        const closed = await create({
          ...over,
          status: 'CANCELLED',
          cancelledAt: at,
          closedAt: at,
          cancelReason: 'CUSTOMER_WITHDREW',
        });
        return { key, national, c1, c2, anchor, sibling, closed };
      }
      const link = (
        id: string,
        customerId: string,
        over: Record<string, unknown> = {},
        role = 'cashier',
        userId: string = users.ana,
      ) =>
        post(
          `/chatbot-requests/${id}/link-customer`,
          { expectedVersion: 1, customerId, ...over },
          role,
          userId,
        );

      it('lists the candidates in the detail, phone masked unless read:CustomerPhone', async () => {
        const { c1, c2, anchor, national } = await ambiguous();
        const masked = await get(`/chatbot-requests/${anchor.id}`, 'cashier');
        expect(masked.body.customer).toMatchObject({
          id: null,
          ambiguous: true,
        });
        expect(
          masked.body.customer.candidates
            .map((c: { id: string }) => c.id)
            .sort(),
        ).toEqual([c1.id, c2.id].sort());
        expect(masked.body.customer.candidates[0].phone).toMatch(/\*{4}/);
        expect(JSON.stringify(masked.body)).not.toContain(national);
        const full = await get(`/chatbot-requests/${anchor.id}`, 'manager');
        expect(full.body.customer.candidates[0].phone).toBe(`+52${national}`);
        expect(masked.body.allowedActions).toContain('LINK_CUSTOMER');
      });

      it('links the request and every other unlinked request of the key, clearing the ambiguity', async () => {
        const { key, c1, anchor, sibling, closed } = await ambiguous();
        const before = await group(key);
        const res = await link(anchor.id, c1.id).expect(200);
        expect(res.body.request).toMatchObject({ id: anchor.id, version: 2 });

        for (const request of [anchor, sibling, closed]) {
          expect(await stored(request.id)).toMatchObject({
            customerId: c1.id,
            ambiguousCustomer: false,
          });
        }
        // CAS bump on the anchor only; the others keep their version
        expect((await stored(anchor.id)).version).toBe(2);
        expect((await stored(sibling.id)).version).toBe(1);
        expect((await stored(closed.id)).status).toBe('CANCELLED');
        expect((await events(anchor.id))[0]).toMatchObject({
          type: 'CUSTOMER_LINKED',
          actorId: users.ana,
          version: 2,
          data: { customerId: c1.id },
        });
        expect((await events(sibling.id))[0]).toMatchObject({
          type: 'CUSTOMER_LINKED',
          version: 1,
          data: { customerId: c1.id, viaRequestId: anchor.id },
        });
        // the key does not change, so the group does not move
        expect(await group(key)).toMatchObject({
          openCount: before?.openCount,
          mostUrgentAt: before?.mostUrgentAt,
        });
        const detail = await get(`/chatbot-requests/${anchor.id}`);
        expect(detail.body.customer).toMatchObject({
          id: c1.id,
          displayName: 'Rosa Duplicada',
          candidates: [],
          ambiguous: false,
        });
        expect(detail.body.allowedActions).not.toContain('LINK_CUSTOMER');
      });

      it('does not offer LINK_CUSTOMER while no customer has that phone, and offers it once one does', async () => {
        const key = phoneKey();
        const request = await create({
          customerKey: key,
          phoneCountryCode: '52',
          phone: key.slice(2),
        });
        const before = await get(`/chatbot-requests/${request.id}`, 'cashier');
        expect(before.body.customer.candidates).toEqual([]);
        expect(before.body.allowedActions).not.toContain('LINK_CUSTOMER');
        await prisma.customer.create({
          data: {
            tenantId: tenantA,
            firstName: 'Llegó después',
            phoneCountryCode: '52',
            phone: key.slice(2),
          },
        });
        const after = await get(`/chatbot-requests/${request.id}`, 'cashier');
        expect(after.body.allowedActions).toContain('LINK_CUSTOMER');
      });

      it('lists exact candidates oldest first and never loses one to a loose match or the cap', async () => {
        const key = phoneKey();
        const national = key.slice(2);
        const request = await create({
          customerKey: key,
          ambiguousCustomer: true,
          phoneCountryCode: '52',
          phone: national,
        });
        // 40 customers of ANOTHER phone sharing the same country code, created
        // first: a loose lookup that takes a page before filtering would fill
        // up with them
        await prisma.customer.createMany({
          data: Array.from({ length: 40 }, (_, i) => ({
            tenantId: tenantA,
            firstName: `Otro ${i}`,
            phoneCountryCode: '52',
            phone: `5599${String(i).padStart(6, '0')}`,
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
          })),
        });
        const forms: Array<[string, string]> = [
          ['52', national],
          ['521', national],
          ['52', `1${national}`],
          ['52', `52${national}`],
        ];
        const made: string[] = [];
        for (let i = 0; i < 12; i++) {
          const [cc, phone] = forms[i % forms.length];
          const customer = await prisma.customer.create({
            data: {
              tenantId: tenantA,
              firstName: `Dup ${String(i).padStart(2, '0')}`,
              phoneCountryCode: cc,
              phone,
              createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
            },
          });
          made.push(customer.id);
        }
        const detail = await get(`/chatbot-requests/${request.id}`);
        expect(
          detail.body.customer.candidates.map((c: { id: string }) => c.id),
        ).toEqual(made.slice(0, 10));
        expect(detail.body.allowedActions).toContain('LINK_CUSTOMER');
      });

      it('accepts the customer stored in the 521 mobile form', async () => {
        const { c2, anchor } = await ambiguous();
        await link(anchor.id, c2.id).expect(200);
        expect(await stored(anchor.id)).toMatchObject({ customerId: c2.id });
      });

      it('links an unambiguous but unlinked request to a customer created later', async () => {
        const key = phoneKey();
        const request = await create({
          customerKey: key,
          phoneCountryCode: '52',
          phone: key.slice(2),
        });
        const customer = await prisma.customer.create({
          data: {
            tenantId: tenantA,
            firstName: 'Nuevo',
            phoneCountryCode: '52',
            phone: key.slice(2),
          },
        });
        const detail = await get(`/chatbot-requests/${request.id}`);
        expect(detail.body.customer.candidates.map((c: any) => c.id)).toEqual([
          customer.id,
        ]);
        await link(request.id, customer.id).expect(200);
      });

      it('404s for a customer of another sucursal, even with the same phone, and for an unknown one', async () => {
        const { anchor, national } = await ambiguous();
        const foreign = await prisma.customer.create({
          data: {
            tenantId: tenantB,
            firstName: 'Foráneo',
            phoneCountryCode: '52',
            phone: national,
          },
        });
        for (const customerId of [foreign.id, randomUUID()]) {
          const res = await link(anchor.id, customerId);
          expect(res.status).toBe(404);
        }
        expect(await stored(anchor.id)).toMatchObject({ customerId: null });
      });

      it('422 CUSTOMER_PHONE_MISMATCH for a customer with another phone, writing nothing', async () => {
        const { anchor, sibling } = await ambiguous();
        const stranger = await prisma.customer.create({
          data: {
            tenantId: tenantA,
            firstName: 'Otro',
            phoneCountryCode: '52',
            phone: '5599990000',
          },
        });
        const noPhone = await prisma.customer.create({
          data: { tenantId: tenantA, firstName: 'Sin teléfono' },
        });
        for (const customerId of [stranger.id, noPhone.id]) {
          const res = await link(anchor.id, customerId);
          expect(res.status).toBe(422);
          expect(res.body.code).toBe('CUSTOMER_PHONE_MISMATCH');
          expect(res.body.current).toMatchObject({ version: 1 });
          expect(JSON.stringify(res.body)).not.toContain('5599990000');
        }
        expect(await stored(anchor.id)).toMatchObject({ customerId: null });
        expect(await stored(sibling.id)).toMatchObject({ customerId: null });
        expect(await events(anchor.id)).toHaveLength(0);
      });

      it('refuses a linked request, an unknown: key, a closed one and a stale version', async () => {
        const { c1, anchor, closed } = await ambiguous();
        await link(anchor.id, c1.id, { expectedVersion: 9 }).expect(409);
        await link(anchor.id, c1.id).expect(200);
        const linked = await link(anchor.id, c1.id, { expectedVersion: 2 });
        expect(linked.status).toBe(422);
        expect(linked.body.code).toBe('ACTION_NOT_ALLOWED');
        const closedRes = await link(closed.id, c1.id);
        expect(closedRes.status).toBe(409);
        expect(closedRes.body.code).toBe('REQUEST_CLOSED');
        const unknown = await create({
          customerKey: `unknown:${randomUUID()}`,
        });
        const unknownRes = await link(unknown.id, c1.id);
        expect(unknownRes.status).toBe(422);
        expect(unknownRes.body.code).toBe('ACTION_NOT_ALLOWED');
        const detail = await get(`/chatbot-requests/${unknown.id}`);
        expect(detail.body.allowedActions).not.toContain('LINK_CUSTOMER');
      });

      it('refuses an unknown: zone request with 422, not a race 409', async () => {
        const { c1 } = await ambiguous();
        const zipCode = String(80_000 + ++seq);
        const validation = await prisma.deliveryZoneValidation.create({
          data: {
            tenantId: tenantA,
            zipCode,
            state: 'CDMX',
            municipality: 'Cuauhtémoc',
            neighborhood: 'Centro',
            branchName: 'Centro',
          },
        });
        const wrapped = await prisma.deliveryZoneRequest.create({
          data: {
            tenantId: tenantA,
            source: 'chatbot',
            sourceRequestId: randomUUID(),
            canonicalRequestHash: 'h',
            submittedCredentialId: 'cred',
            validationId: validation.id,
            branchName: 'Centro',
            zipCode,
            state: 'CDMX',
            municipality: 'Cuauhtémoc',
            neighborhood: 'Centro',
            // an unparseable phone is what gives a zone request an unknown: key
            customerPhoneCountryCode: '52',
            customerPhone: 'no-phone',
            conversationRef: `wa:unknown-${randomUUID()}`,
            lastCustomerMessageAt: NOW,
          },
        });
        const zone = await create({
          customerKey: `unknown:${wrapped.id}`,
          kind: 'DECISION',
          subtype: 'DELIVERY_ZONE',
          deliveryZoneRequestId: wrapped.id,
        });
        const before = await prisma.chatbotRequest.findUniqueOrThrow({
          where: { id: zone.id },
        });
        const res = await link(zone.id, c1.id);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('ACTION_NOT_ALLOWED');
        const after = await prisma.chatbotRequest.findUniqueOrThrow({
          where: { id: zone.id },
        });
        expect(after.version).toBe(before.version);
        expect(after.customerId).toBeNull();
      });

      it('requires read + update:ChatbotRequest and 404s another sucursal', async () => {
        const { c1, anchor } = await ambiguous();
        await link(anchor.id, c1.id, {}, 'readOnly').expect(403);
        const foreign = await create({ customerKey: phoneKey() }, tenantB);
        await link(foreign.id, c1.id).expect(404);
      });

      it('replays the same key with one event per request', async () => {
        const { c1, anchor, sibling } = await ambiguous();
        const key = randomUUID();
        const first = await link(anchor.id, c1.id, {}, 'cashier', users.ana)
          .set('Idempotency-Key', key)
          .expect(200);
        const again = await link(anchor.id, c1.id, {}, 'cashier', users.ana)
          .set('Idempotency-Key', key)
          .expect(200);
        expect(again.body).toEqual(first.body);
        expect(await events(anchor.id)).toHaveLength(1);
        expect(await events(sibling.id)).toHaveLength(1);
      });

      it('link vs claim of the same request: exactly one wins on the version', async () => {
        for (let round = 0; round < 6; round++) {
          const { c1, anchor } = await ambiguous();
          const [l, c] = await Promise.all([
            link(anchor.id, c1.id),
            post(`/chatbot-requests/${anchor.id}/claim`, {
              expectedVersion: 1,
            }),
          ]);
          expect([l.status, c.status].filter((s) => s === 200)).toHaveLength(1);
          const loser = l.status === 200 ? c : l;
          expect(loser.status).toBe(409);
          expect(loser.body.current.version).toBe(2);
          expect((await stored(anchor.id)).version).toBe(2);
        }
      });

      it('link vs claim of a sibling: both win and both effects stay', async () => {
        for (let round = 0; round < 6; round++) {
          const { c1, anchor, sibling } = await ambiguous();
          const [l, c] = await Promise.all([
            link(anchor.id, c1.id),
            post(`/chatbot-requests/${sibling.id}/claim`, {
              expectedVersion: 1,
            }),
          ]);
          expect([l.status, c.status]).toEqual([200, 200]);
          expect(await stored(sibling.id)).toMatchObject({
            status: 'IN_PROGRESS',
            assigneeUserId: users.ana,
            customerId: c1.id,
            ambiguousCustomer: false,
            version: 2,
          });
        }
      });

      it('two links of one key at once (different anchors, different customers): no deadlock, one wins', async () => {
        for (let round = 0; round < 8; round++) {
          const { c1, c2, anchor, sibling } = await ambiguous();
          const [first, second] = await Promise.all([
            link(anchor.id, c1.id),
            link(sibling.id, c2.id),
          ]);
          expect([first.status, second.status].sort()).toEqual([200, 422]);
          const winner = first.status === 200 ? c1.id : c2.id;
          expect(await stored(anchor.id)).toMatchObject({ customerId: winner });
          expect(await stored(sibling.id)).toMatchObject({
            customerId: winner,
          });
        }
      });

      describe('a zone request created after the zip locks (L1)', () => {
        /** Creates a zone request of `key` right after the zip locks, `times` times. */
        class InjectingStore extends PrismaChatbotRequestRelationStore {
          injections = 0;
          constructor(
            tenants: TenantPrismaService,
            private readonly inject: () => Promise<void>,
            private times: number,
          ) {
            super(tenants);
          }
          override async lockZonesOfKey(customerKey: string) {
            const zips = await super.lockZonesOfKey(customerKey);
            if (this.times > 0) {
              this.times--;
              this.injections++;
              await this.inject();
            }
            return zips;
          }
        }

        async function scenario(times: number) {
          const { c1, key, national, anchor } = await ambiguousWithKey();
          const injected: string[] = [];
          const store = new InjectingStore(
            tenantPrisma,
            async () => {
              // committed on another connection, like a bot intake would
              const zipCode = String(80_000 + ++seq);
              const validation = await prisma.deliveryZoneValidation.create({
                data: {
                  tenantId: tenantA,
                  zipCode,
                  state: 'CDMX',
                  municipality: 'Cuauhtémoc',
                  neighborhood: 'Centro',
                  branchName: 'Centro',
                },
              });
              const wrapped = await prisma.deliveryZoneRequest.create({
                data: {
                  tenantId: tenantA,
                  source: 'chatbot',
                  sourceRequestId: randomUUID(),
                  canonicalRequestHash: 'h',
                  submittedCredentialId: 'cred',
                  validationId: validation.id,
                  branchName: 'Centro',
                  zipCode,
                  state: 'CDMX',
                  municipality: 'Cuauhtémoc',
                  neighborhood: 'Centro',
                  customerPhoneCountryCode: '52',
                  customerPhone: national,
                  conversationRef: `wa:${key}`,
                  lastCustomerMessageAt: NOW,
                },
              });
              const created = await create({
                customerKey: key,
                kind: 'DECISION',
                subtype: 'DELIVERY_ZONE',
                deliveryZoneRequestId: wrapped.id,
                ambiguousCustomer: true,
                phoneCountryCode: '52',
                phone: national,
              });
              injected.push(created.id);
            },
            times,
          );
          const service = new ChatbotRequestRelationsService(
            new PrismaChatbotRequestCommandStore(tenantPrisma),
            store,
          );
          const run = () =>
            cls.runWith(
              { tenantId: tenantA, userId: users.ana, isSuperAdmin: false },
              () =>
                service.linkCustomer({
                  requestId: anchor.id,
                  actorUserId: users.ana,
                  idempotencyKey: randomUUID(),
                  expectedVersion: 1,
                  customerId: c1.id,
                }),
            );
          return { run, store, injected, anchor, c1 };
        }

        /** An ambiguous key with one open request, plus its candidate customers. */
        async function ambiguousWithKey() {
          const setup = await ambiguous();
          return setup;
        }

        it('detects it, rolls back and retries once from the start: the new zone request is linked too', async () => {
          const { run, store, injected, anchor, c1 } = await scenario(1);
          const view = await run();
          expect(view).toMatchObject({ id: anchor.id, version: 2 });
          expect(store.injections).toBe(1);
          expect(injected).toHaveLength(1);
          for (const id of [anchor.id, ...injected]) {
            expect(await stored(id)).toMatchObject({
              customerId: c1.id,
              ambiguousCustomer: false,
            });
          }
          // one command, one audit event on the anchor (the aborted try left none)
          expect(await events(anchor.id)).toHaveLength(1);
        });

        it('answers 409 VERSION_CONFLICT with the current row when it happens again, writing nothing', async () => {
          const { run, store, injected, anchor } = await scenario(2);
          await expect(run()).rejects.toMatchObject({
            code: 'VERSION_CONFLICT',
            httpStatus: 409,
            current: { version: 1, status: 'NEW' },
          });
          expect(store.injections).toBe(2);
          expect(await stored(anchor.id)).toMatchObject({
            customerId: null,
            version: 1,
          });
          for (const id of injected) {
            expect(await stored(id)).toMatchObject({ customerId: null });
          }
          expect(await events(anchor.id)).toHaveLength(0);
        });
      });

      it('a zone request of the key links too, and a concurrent zone resolve never deadlocks', async () => {
        for (let round = 0; round < 6; round++) {
          const key = phoneKey();
          const national = key.slice(2);
          const customer = await prisma.customer.create({
            data: {
              tenantId: tenantA,
              firstName: 'Zona',
              phoneCountryCode: '52',
              phone: national,
            },
          });
          const zipCode = String(70_000 + ++seq);
          const validation = await prisma.deliveryZoneValidation.create({
            data: {
              tenantId: tenantA,
              zipCode,
              state: 'CDMX',
              municipality: 'Cuauhtémoc',
              neighborhood: 'Centro',
              branchName: 'Centro',
            },
          });
          const zone = async (customerKey: string, phone: string) => {
            const wrapped = await prisma.deliveryZoneRequest.create({
              data: {
                tenantId: tenantA,
                source: 'chatbot',
                sourceRequestId: randomUUID(),
                canonicalRequestHash: 'h',
                submittedCredentialId: 'cred',
                validationId: validation.id,
                branchName: 'Centro',
                zipCode,
                state: 'CDMX',
                municipality: 'Cuauhtémoc',
                neighborhood: 'Centro',
                customerPhoneCountryCode: '52',
                customerPhone: phone,
                conversationRef: `wa:${customerKey}`,
                lastCustomerMessageAt: NOW,
              },
            });
            return create({
              customerKey,
              kind: 'DECISION',
              subtype: 'DELIVERY_ZONE',
              deliveryZoneRequestId: wrapped.id,
              phoneCountryCode: '52',
              phone,
            });
          };
          const mine = await zone(key, national);
          const sameKey = await create({
            customerKey: key,
            phoneCountryCode: '52',
            phone: national,
          });
          const otherKey = phoneKey();
          const neighbour = await zone(otherKey, otherKey.slice(2));
          const impact = await get(
            `/chatbot-requests/${neighbour.id}/zone-impact`,
          ).expect(200);
          const [l, r] = await Promise.all([
            link(sameKey.id, customer.id),
            post(`/chatbot-requests/${neighbour.id}/resolve`, {
              expectedVersion: 1,
              action: 'REJECT_DELIVERY_ZONE',
              expectedZoneSetVersion: impact.body.setVersion,
            }),
          ]);
          expect([l.status, r.status]).toEqual([200, 200]);
          expect(await stored(mine.id)).toMatchObject({
            customerId: customer.id,
          });
        }
      });
    });
  },
);
