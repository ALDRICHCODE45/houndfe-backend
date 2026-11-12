/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 7a — chatbot attention settings against REAL
 * PostgreSQL: Supertest → the settings controller (stub guards set the caller
 * and the CASL grants) → real service and SQL. Covers GET defaults and
 * `branchOpeningHours`, PUT validation and the version CAS (including a real
 * concurrent race), apply-to-all by membership (S7), the recompute of OPEN
 * requests on a change (closed rows untouched, bounded batches, never
 * overwriting a newer version), and the SLA columns written on create, claim
 * and release (contract §5.4, §5.5, §12.9, §10.1).
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { randomUUID } from 'crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { PERMISSIONS_KEY } from '../auth/authorization/decorators/require-permissions.decorator';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../auth/authorization/domain/permission';
import { CaslAbilityFactory } from '../auth/authorization/casl-ability.factory';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { insertRequestOnDedup } from '../chatbot-requests/infrastructure/chatbot-request-intake-writes';
import {
  allocateFolio,
  applyRequestPatch,
} from '../chatbot-requests/infrastructure/chatbot-request-writes';
import * as recomputeModule from '../chatbot-requests/infrastructure/chatbot-sla-recompute';
import { recomputeOpenRequests } from '../chatbot-requests/infrastructure/chatbot-sla-recompute';
import { slaColumnsForNew } from '../chatbot-requests/infrastructure/chatbot-sla-policy';
import { InsufficientPermissionsError } from '../shared/domain/domain-error';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import {
  ChatbotSettingsService,
  SETTINGS_CLOCK,
} from './application/chatbot-settings.service';
import { defaultSettings } from './domain/chatbot-attention-settings';
import { policyFromSettings } from '../chatbot-requests/domain/chatbot-sla';
import { ChatbotSettingsController } from './presentation/chatbot-settings.controller';
import { ChatbotSettingsHttpFilter } from './presentation/chatbot-settings.filter';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

type Grant = [AppActions, AppSubjects];
const ROLES: Record<string, Grant[]> = {
  admin: [
    ['read', 'ChatbotSettings'],
    ['update', 'ChatbotSettings'],
    ['update', 'ChatbotSettingsAllBranches'],
  ],
  manager: [
    ['read', 'ChatbotSettings'],
    ['update', 'ChatbotSettings'],
  ],
  viewer: [['read', 'ChatbotSettings']],
  none: [],
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

const NOW = new Date('2026-11-10T12:00:00.000Z');
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** Open every day 00:00-23:59 in UTC, so deadlines are plain minute sums. */
const ALWAYS_OPEN = () => {
  const base = defaultSettings();
  return {
    openingHours: {
      timeZone: 'UTC',
      days: base.openingHours.days.map((d) => ({
        day: d.day,
        ranges: [{ open: '00:00', close: '23:59' }],
      })),
    },
    closedDates: [] as string[],
    slas: base.slas,
    windowWarningMinutes: base.windowWarningMinutes,
    templateName: base.templateName,
    templateCostText: base.templateCostText,
    enabledSubtypes: base.enabledSubtypes,
    receiptCloseMarginMinutes: base.receiptCloseMarginMinutes,
    scheduling: base.scheduling,
  };
};

describeIfDb('chatbot attention settings (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  let app: INestApplication;
  let root: PrismaService;
  let casl: CaslAbilityFactory;
  const tenantA: string = randomUUID();
  const tenantB: string = randomUUID();
  const tenantC: string = randomUUID();
  const tenantD: string = randomUUID();
  const tenantE: string = randomUUID();
  const tenants = [tenantA, tenantB, tenantC, tenantD, tenantE];
  const userId: string = randomUUID();
  const otherUser: string = randomUUID();
  const roleIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
      ],
      controllers: [ChatbotSettingsController],
      providers: [
        CaslAbilityFactory,
        ChatbotSettingsHttpFilter,
        ChatbotSettingsService,
        { provide: SETTINGS_CLOCK, useValue: () => NOW },
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
    root = moduleRef.get(PrismaService);
    casl = moduleRef.get(CaslAbilityFactory);
    for (const [i, id] of tenants.entries()) {
      await prisma.tenant.create({
        data: {
          id,
          name: `Sucursal ${i}`,
          slug: `cs-${id}`,
          isActive: id !== tenantE,
        },
      });
    }
    for (const id of [userId, otherUser]) {
      await prisma.user.create({
        data: {
          id,
          email: `${id}@settings.test`,
          hashedPassword: 'x',
          name: 'Ana',
        },
      });
    }
    await seedMemberships();
  }, 60_000);

  /**
   * userId: admin grant (`update:ChatbotSettingsAllBranches`) in A, B and E
   * (E is inactive; A's role also reads the settings, B's does not); a role WITHOUT it in C; a `manage:all` role in D through a
   * second membership next to a plain role (grants merge across memberships).
   * otherUser: a membership in B only, without the grant.
   */
  async function seedMemberships() {
    const perm = (subject: string, action: string) =>
      prisma.permission.upsert({
        where: { subject_action: { subject, action } },
        create: { subject, action },
        update: {},
      });
    const allBranches = await perm('ChatbotSettingsAllBranches', 'update');
    const settings = await perm('ChatbotSettings', 'update');
    const readSettings = await perm('ChatbotSettings', 'read');
    const manageAll = await perm('all', 'manage');
    const role = async (
      tenantId: string,
      name: string,
      permissionIds: string[],
    ) => {
      const created = await prisma.role.create({
        data: {
          tenantId,
          name,
          permissions: {
            create: permissionIds.map((permissionId) => ({ permissionId })),
          },
        },
      });
      roleIds.push(created.id);
      return created.id;
    };
    const member = (uid: string, tenantId: string, roleId: string) =>
      prisma.tenantMembership.create({
        data: { userId: uid, tenantId, roleId },
      });
    await member(
      userId,
      tenantA,
      await role(tenantA, 'admin', [allBranches.id, readSettings.id]),
    );
    await member(
      userId,
      tenantB,
      await role(tenantB, 'admin', [allBranches.id]),
    );
    await member(userId, tenantC, await role(tenantC, 'plain', [settings.id]));
    await member(userId, tenantD, await role(tenantD, 'plain', [settings.id]));
    await member(userId, tenantD, await role(tenantD, 'all', [manageAll.id]));
    await member(
      userId,
      tenantE,
      await role(tenantE, 'admin', [allBranches.id]),
    );
    await member(
      otherUser,
      tenantB,
      await role(tenantB, 'viewer', [settings.id]),
    );
  }

  afterAll(async () => {
    await app.close();
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.user.deleteMany({
      where: { id: { in: [userId, otherUser] } },
    });
  });

  // -------------------------------------------------------------- helpers

  const as = (role: string, tenantId: string, uid: string = userId) => ({
    'x-test-role': role,
    'x-test-tenant': tenantId,
    'x-test-user': uid,
  });
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const get = (tenantId: string, role = 'manager') =>
    request(server()).get('/chatbot-settings').set(as(role, tenantId));
  const put = (tenantId: string, body: object, role = 'manager') =>
    request(server())
      .put('/chatbot-settings')
      .set(as(role, tenantId))
      .send(body);
  const applyAll = (tenantId: string, body: object = {}, role = 'admin') =>
    request(server())
      .post('/chatbot-settings/apply-to-all-tenants')
      .set(as(role, tenantId))
      .send(body);

  /** A PUT body from a settings object. */
  const body = (settings: object, expectedVersion: number) => ({
    ...settings,
    expectedVersion,
  });

  /** An open or closed request with stale SLA columns. */
  async function seedRequest(
    tenantId: string,
    over: Record<string, unknown> = {},
  ) {
    seq += 1;
    return prisma.chatbotRequest.create({
      data: {
        tenantId,
        folio: 100_000 + seq,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: `5255100${String(seq).padStart(5, '0')}`,
        summary: `Pregunta ${seq}`,
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        createdAt: NOW,
        claimDeadlineAt: new Date('2026-01-01T00:00:00Z'),
        resolveDeadlineAt: new Date('2026-01-01T01:00:00Z'),
        slaPolicyVersion: 0,
        ...over,
      } as never,
    });
  }

  // ------------------------------------------------------------------ GET

  it('GET without a row answers the defaults at version 0 with branchOpeningHours null', async () => {
    const res = await get(tenantA).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.version).toBe(0);
    expect(res.body.branchOpeningHours).toBeNull();
    expect(res.body.openingHours.timeZone).toBe('America/Mexico_City');
    expect(res.body.slas).toHaveLength(8);
    expect(res.body.receiptCloseMarginMinutes).toBe(60);
    expect(res.body.closedDates).toEqual([]);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'branchOpeningHours',
        'closedDateReasons',
        'closedDates',
        'enabledSubtypes',
        'openingHours',
        'receiptCloseMarginMinutes',
        'scheduling',
        'slas',
        'templateCostText',
        'templateName',
        'updatedAt',
        'updatedBy',
        'version',
        'windowWarningMinutes',
      ].sort(),
    );
  });

  it('GET adds the pickup opening hours of the same tenant, read-only', async () => {
    const days = defaultSettings().openingHours.days.map((d) => ({
      ...d,
      ranges:
        d.day === 'SUNDAY' ? [{ open: '10:00', close: '12:00' }] : d.ranges,
    }));
    await prisma.tenantOpeningHours.create({
      data: { tenantId: tenantC, timeZone: 'America/Tijuana', days },
    });
    const res = await get(tenantC).expect(200);
    expect(res.body.branchOpeningHours.timeZone).toBe('America/Tijuana');
    expect(
      res.body.branchOpeningHours.days.find(
        (d: { day: string }) => d.day === 'SUNDAY',
      ).ranges,
    ).toEqual([{ open: '10:00', close: '12:00' }]);
    // The chat schedule is its own: the defaults, not the pickup hours.
    expect(res.body.openingHours.timeZone).toBe('America/Mexico_City');
    // Another tenant sees none of it.
    expect((await get(tenantA).expect(200)).body.branchOpeningHours).toBeNull();
  });

  it('needs read:ChatbotSettings', async () => {
    await get(tenantA, 'none').expect(403);
  });

  // ------------------------------------------------------------------ PUT

  describe('PUT', () => {
    it('creates the row at version 1, returns the body and audits it', async () => {
      const settings = {
        ...ALWAYS_OPEN(),
        closedDates: ['2026-12-25', '2026-01-01'],
      };
      const res = await put(tenantA, body(settings, 0)).expect(200);
      expect(res.body.version).toBe(1);
      expect(res.body.closedDates).toEqual(['2026-01-01', '2026-12-25']);
      expect(res.body.openingHours.timeZone).toBe('UTC');
      const events = await prisma.chatbotAttentionSettingsEvent.findMany({
        where: { tenantId: tenantA },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'UPDATED',
        fromVersion: 0,
        toVersion: 1,
        actorUserId: userId,
        actorDisplayName: 'Ana',
      });
      expect((events[0].data as { changed: string[] }).changed).toEqual(
        expect.arrayContaining(['openingHours', 'closedDates']),
      );
    });

    it('a stale expectedVersion is 409 VERSION_CONFLICT carrying the current settings', async () => {
      const res = await put(tenantA, body(ALWAYS_OPEN(), 0)).expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'VERSION_CONFLICT',
      });
      expect(res.body.current.version).toBe(1);
      expect(res.body.current.openingHours.timeZone).toBe('UTC');
      expect(res.body.current.branchOpeningHours).toBeNull();
    });

    it('bumps the version on a change and treats identical content as a no-op', async () => {
      const first = (await get(tenantA)).body;
      const changed = {
        ...ALWAYS_OPEN(),
        closedDates: first.closedDates,
        windowWarningMinutes: 90,
      };
      const second = await put(tenantA, body(changed, 1)).expect(200);
      expect(second.body.version).toBe(2);
      expect(second.body.windowWarningMinutes).toBe(90);
      const same = await put(tenantA, body(changed, 2)).expect(200);
      expect(same.body.version).toBe(2);
      expect(
        await prisma.chatbotAttentionSettingsEvent.count({
          where: { tenantId: tenantA },
        }),
      ).toBe(2);
    });

    it('ignores branchOpeningHours when it comes in the body (§12.9)', async () => {
      const current = (await get(tenantA)).body;
      const res = await put(tenantA, {
        ...body(
          {
            ...ALWAYS_OPEN(),
            closedDates: current.closedDates,
            windowWarningMinutes: 90,
          },
          2,
        ),
        branchOpeningHours: { timeZone: 'Asia/Tokyo', days: [] },
      }).expect(200);
      expect(res.body.version).toBe(2);
      expect(res.body.openingHours.timeZone).toBe('UTC');
    });

    it.each([
      [
        'an overlapping range',
        (s: ReturnType<typeof ALWAYS_OPEN>) => {
          s.openingHours.days[0].ranges = [
            { open: '09:00', close: '14:00' },
            { open: '13:00', close: '18:00' },
          ];
        },
        'INVALID_OPENING_HOURS',
      ],
      [
        'a range crossing midnight',
        (s: ReturnType<typeof ALWAYS_OPEN>) => {
          s.openingHours.days[0].ranges = [{ open: '22:00', close: '02:00' }];
        },
        'INVALID_OPENING_HOURS',
      ],
      [
        'an invalid zone',
        (s: ReturnType<typeof ALWAYS_OPEN>) => {
          s.openingHours.timeZone = 'Mars/Olympus';
        },
        'INVALID_OPENING_HOURS',
      ],
      [
        'a week with no open range',
        (s: ReturnType<typeof ALWAYS_OPEN>) => {
          for (const d of s.openingHours.days) d.ranges = [];
        },
        'INVALID_CHATBOT_SETTINGS',
      ],
      [
        'an impossible closed date',
        (s: ReturnType<typeof ALWAYS_OPEN>) => {
          s.closedDates = ['2026-02-30'];
        },
        'INVALID_CHATBOT_SETTINGS',
      ],
      [
        'a missing subtype in slas',
        (s: ReturnType<typeof ALWAYS_OPEN>) => {
          s.slas = s.slas.slice(1);
        },
        'INVALID_CHATBOT_SETTINGS',
      ],
    ])(
      'rejects %s with 400 VALIDATION_ERROR',
      async (_label, mutate, reason) => {
        const settings = ALWAYS_OPEN();
        mutate(settings);
        const res = await put(tenantB, body(settings, 0)).expect(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', reason });
      },
    );

    it('rejects an unknown field and a missing expectedVersion with 400', async () => {
      await put(tenantB, {
        ...body(ALWAYS_OPEN(), 0),
        tenantId: tenantA,
      }).expect(400);
      await put(tenantB, ALWAYS_OPEN()).expect(400);
      expect(
        await root.chatbotAttentionSettings.count({
          where: { tenantId: tenantB },
        }),
      ).toBe(0);
    });

    it('needs read and update:ChatbotSettings', async () => {
      await put(tenantB, body(ALWAYS_OPEN(), 0), 'viewer').expect(403);
      await put(tenantB, body(ALWAYS_OPEN(), 0), 'none').expect(403);
    });

    it('concurrent PUTs on one version: exactly one wins, the others get 409 with the winner', async () => {
      const tenant = tenantD;
      const writers = 8;
      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) =>
          put(
            tenant,
            body({ ...ALWAYS_OPEN(), windowWarningMinutes: 10 + i }, 0),
          ),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(writers - 1);
      const winner = results.find((r) => r.status === 200)!;
      expect(winner.body.version).toBe(1);
      for (const loser of results.filter((r) => r.status === 409)) {
        expect(loser.body.code).toBe('VERSION_CONFLICT');
        expect(loser.body.current.windowWarningMinutes).toBe(
          winner.body.windowWarningMinutes,
        );
      }
      expect(
        await prisma.chatbotAttentionSettingsEvent.count({
          where: { tenantId: tenant },
        }),
      ).toBe(1);

      // The same race on an existing row (version 1 -> 2).
      const again = await Promise.all(
        Array.from({ length: writers }, (_, i) =>
          put(
            tenant,
            body({ ...ALWAYS_OPEN(), windowWarningMinutes: 100 + i }, 1),
          ),
        ),
      );
      expect(again.filter((r) => r.status === 200)).toHaveLength(1);
      expect(again.filter((r) => r.status === 409)).toHaveLength(writers - 1);
      expect((await get(tenant)).body.version).toBe(2);
    });
  });

  // ------------------------------------------------- recompute on change

  describe('recompute of open requests on a settings change (§5.4)', () => {
    const tenant = tenantC;

    it('recomputes NEW and IN_PROGRESS rows and leaves closed rows untouched', async () => {
      const open = await seedRequest(tenant, { status: 'NEW' });
      const claimed = await seedRequest(tenant, {
        status: 'IN_PROGRESS',
        assigneeUserId: userId,
        assigneeDisplayName: 'Ana',
        claimedAt: NOW,
      });
      const resolvedAt = new Date('2026-11-09T10:00:00Z');
      const resolved = await seedRequest(tenant, {
        status: 'RESOLVED',
        resolvedAt,
        closedAt: resolvedAt,
        resolvedByActorId: userId,
        resolvedByDisplayName: 'Ana',
      });
      const cancelled = await seedRequest(tenant, {
        status: 'CANCELLED',
        cancelledAt: resolvedAt,
        closedAt: resolvedAt,
        cancelReason: 'CUSTOMER_WITHDREW',
      });
      const before = await prisma.chatbotRequest.findMany({
        where: { id: { in: [resolved.id, cancelled.id] } },
        orderBy: { id: 'asc' },
      });

      const res = await put(tenant, body(ALWAYS_OPEN(), 0)).expect(200);
      expect(res.body.version).toBe(1);

      const afterOpen = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: open.id },
      });
      expect(afterOpen.slaPolicyVersion).toBe(1);
      expect(iso(afterOpen.claimDeadlineAt)).toBe('2026-11-10T12:30:00.000Z');
      expect(iso(afterOpen.resolveDeadlineAt)).toBe('2026-11-10T14:00:00.000Z');
      // 50 % of the 30-minute claim window.
      expect(iso(afterOpen.nextSlaCheckAt)).toBe('2026-11-10T12:15:00.000Z');

      const afterClaimed = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: claimed.id },
      });
      expect(afterClaimed.slaPolicyVersion).toBe(1);
      // The claim deadline of an in-progress request is history: kept as is.
      expect(iso(afterClaimed.claimDeadlineAt)).toBe(
        '2026-01-01T00:00:00.000Z',
      );
      expect(iso(afterClaimed.resolveDeadlineAt)).toBe(
        '2026-11-10T14:00:00.000Z',
      );
      expect(iso(afterClaimed.nextSlaCheckAt)).toBe('2026-11-10T13:00:00.000Z');

      const after = await prisma.chatbotRequest.findMany({
        where: { id: { in: [resolved.id, cancelled.id] } },
        orderBy: { id: 'asc' },
      });
      expect(after).toEqual(before);
      for (const row of after) {
        expect(row.slaPolicyVersion).toBe(0);
        expect(row.nextSlaCheckAt).toBeNull();
      }
    });

    it('refreshes the customer group urgency in the same pass', async () => {
      const row = await seedRequest(tenant, {
        status: 'NEW',
        slaPolicyVersion: 0,
      });
      await prisma.chatbotCustomerGroup.create({
        data: {
          tenantId: tenant,
          customerKey: row.customerKey,
          openCount: 1,
          mostUrgentAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      const current = (await get(tenant)).body;
      await put(
        tenant,
        body(
          { ...ALWAYS_OPEN(), closedDates: [], windowWarningMinutes: 77 },
          current.version,
        ),
      ).expect(200);
      const group = await prisma.chatbotCustomerGroup.findUniqueOrThrow({
        where: {
          tenantId_customerKey: {
            tenantId: tenant,
            customerKey: row.customerKey,
          },
        },
      });
      expect(iso(group.mostUrgentAt)).toBe('2026-11-10T12:30:00.000Z');
    });

    it('works in bounded batches and never overwrites a newer version', async () => {
      const tenantRows = tenantB;
      await root.chatbotAttentionSettings.create({
        data: {
          tenantId: tenantRows,
          version: 5,
          timeZone: 'UTC',
          days: ALWAYS_OPEN().openingHours.days,
          closedDates: [],
          // SAFETY: the SLA table is plain JSON.
          slas: ALWAYS_OPEN().slas as unknown as Prisma.InputJsonValue,
          windowWarningMinutes: 120,
          templateName: null,
          templateCostText: 'x',
          enabledSubtypes: [],
          receiptCloseMarginMinutes: 60,
          schedulingEnabled: false,
          slotMinutes: 30,
          slotsOffered: 3,
          maxScheduledPerSlot: 3,
        },
      });
      const stale = await Promise.all(
        Array.from({ length: 5 }, () =>
          seedRequest(tenantRows, { status: 'NEW' }),
        ),
      );
      const newer = await seedRequest(tenantRows, {
        status: 'NEW',
        slaPolicyVersion: 9,
        claimDeadlineAt: new Date('2030-01-01T00:00:00Z'),
      });
      const result = await recomputeOpenRequests(root, tenantRows, {
        batchSize: 2,
        now: () => NOW,
        retries: 0,
      });
      expect(result).toEqual({ recomputed: 5, stale: 0 });
      for (const row of stale) {
        const after = await prisma.chatbotRequest.findUniqueOrThrow({
          where: { id: row.id },
        });
        expect(after.slaPolicyVersion).toBe(5);
        expect(iso(after.claimDeadlineAt)).toBe('2026-11-10T12:30:00.000Z');
      }
      const untouched = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: newer.id },
      });
      expect(untouched.slaPolicyVersion).toBe(9);
      expect(iso(untouched.claimDeadlineAt)).toBe('2030-01-01T00:00:00.000Z');
    });

    it('skips a row a command holds, then reports it as stale instead of waiting', async () => {
      const tenantHeld = tenantE;
      await root.chatbotAttentionSettings.create({
        data: {
          tenantId: tenantHeld,
          version: 2,
          timeZone: 'UTC',
          days: ALWAYS_OPEN().openingHours.days,
          closedDates: [],
          // SAFETY: the SLA table is plain JSON.
          slas: ALWAYS_OPEN().slas as unknown as Prisma.InputJsonValue,
          windowWarningMinutes: 120,
          templateName: null,
          templateCostText: 'x',
          enabledSubtypes: [],
          receiptCloseMarginMinutes: 60,
          schedulingEnabled: false,
          slotMinutes: 30,
          slotsOffered: 3,
          maxScheduledPerSlot: 3,
        },
      });
      const free = await seedRequest(tenantHeld, { status: 'NEW' });
      const held = await seedRequest(tenantHeld, { status: 'NEW' });
      let release!: () => void;
      const holding = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT 1 FROM chatbot_requests WHERE id = ${held.id} FOR UPDATE`,
        );
        locked();
        await holding;
      });
      await lockTaken;
      const result = await recomputeOpenRequests(root, tenantHeld, {
        now: () => NOW,
        retries: 1,
        retryDelayMs: 20,
      });
      release();
      await holder;
      expect(result.stale).toBe(1);
      expect(
        (
          await prisma.chatbotRequest.findUniqueOrThrow({
            where: { id: free.id },
          })
        ).slaPolicyVersion,
      ).toBe(2);
      expect(
        (
          await prisma.chatbotRequest.findUniqueOrThrow({
            where: { id: held.id },
          })
        ).slaPolicyVersion,
      ).toBe(0);
      // Once released, the next pass finishes it.
      expect(
        await recomputeOpenRequests(root, tenantHeld, { now: () => NOW }),
      ).toEqual({ recomputed: 1, stale: 0 });
    });
  });

  // ----------------------------------------- SLA on create, claim, release

  describe('SLA columns on create and on claim / release', () => {
    const tenant = tenantA;

    async function insert(subtype: 'UNKNOWN_QUESTION' | 'TRANSFER_RECEIPT') {
      return root.$transaction(async (tx) => {
        // SAFETY: the transaction client has the raw SQL the helpers use.
        const client = tx as never;
        const folio = await allocateFolio(client, tenant);
        const id = await insertRequestOnDedup(
          client,
          {
            tenantId: tenant,
            folio,
            kind: subtype === 'UNKNOWN_QUESTION' ? 'CLARIFICATION' : 'DECISION',
            subtype,
            customerKey: `5255200${String(folio).padStart(5, '0')}`,
            summary: 'Nueva',
            source: 'chatbot',
            sourceRequestId: randomUUID(),
            ...(subtype === 'TRANSFER_RECEIPT'
              ? { receiptEvidenceId: undefined }
              : {}),
          } as never,
          new Date(),
        );
        return id!;
      });
    }

    it('create stamps the deadlines, the policy version and the first check', async () => {
      // Tenant A is on version 2 (ALWAYS_OPEN UTC, 30 / 120 minutes).
      const id = await insert('UNKNOWN_QUESTION').catch((e: unknown) => e);
      expect(typeof id).toBe('string');
      const row = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: id as string },
      });
      expect(row.slaPolicyVersion).toBe(2);
      const created = row.createdAt.getTime();
      expect(row.claimDeadlineAt!.getTime() - created).toBeGreaterThan(
        29 * 60_000 - 5_000,
      );
      expect(row.claimDeadlineAt!.getTime() - created).toBeLessThan(
        30 * 60_000 + 5_000,
      );
      expect(row.resolveDeadlineAt).not.toBeNull();
      expect(row.nextSlaCheckAt).not.toBeNull();
    });

    it('a tenant without settings gets the defaults at version 0', async () => {
      const tenantNoRow = tenantD;
      await root.chatbotAttentionSettings.delete({
        where: { tenantId: tenantNoRow },
      });
      const id = await root.$transaction(async (tx) => {
        const client = tx as never;
        return insertRequestOnDedup(client, {
          tenantId: tenantNoRow,
          folio: await allocateFolio(client, tenantNoRow),
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          customerKey: '525520099999',
          summary: 'Sin fila',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
        } as never);
      });
      const row = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: id! },
      });
      expect(row.slaPolicyVersion).toBe(0);
      expect(row.claimDeadlineAt).not.toBeNull();
    });

    it('claim moves to the resolve clock; release restarts the claim clock at the release', async () => {
      const row = await seedRequest(tenant, {
        status: 'NEW',
        slaPolicyVersion: 2,
        createdAt: new Date('2026-11-10T08:00:00Z'),
      });
      const claimAt = new Date('2026-11-10T08:10:00Z');
      await root.$transaction(async (tx) => {
        await applyRequestPatch(
          tx as never,
          tenant,
          { id: row.id, version: row.version },
          {
            status: 'IN_PROGRESS',
            version: 2,
            assigneeUserId: userId,
            assigneeDisplayName: 'Ana',
            claimedAt: claimAt,
          },
          {
            type: 'CLAIMED',
            actorKind: 'USER',
            actorId: userId,
            actorDisplayName: 'Ana',
            fromStatus: 'NEW',
            toStatus: 'IN_PROGRESS',
            version: 2,
            data: {},
          },
          claimAt,
        );
      });
      const claimed = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: row.id },
      });
      // Resolve clock from creation: 08:00 + 120 min. 50 % is 09:00.
      expect(iso(claimed.resolveDeadlineAt)).toBe('2026-11-10T10:00:00.000Z');
      expect(iso(claimed.nextSlaCheckAt)).toBe('2026-11-10T09:00:00.000Z');
      expect(iso(claimed.claimDeadlineAt)).toBe('2026-01-01T00:00:00.000Z');

      const releaseAt = new Date('2026-11-10T08:40:00Z');
      await root.$transaction(async (tx) => {
        await tx.chatbotRequestEvent.create({
          data: {
            tenantId: tenant,
            requestId: row.id,
            type: 'RELEASED',
            actorKind: 'USER',
            actorId: userId,
            actorDisplayName: 'Ana',
            fromStatus: 'IN_PROGRESS',
            toStatus: 'NEW',
            version: 3,
            data: {},
            createdAt: releaseAt,
          },
        });
        await applyRequestPatch(
          tx as never,
          tenant,
          { id: row.id, version: 2 },
          {
            status: 'NEW',
            version: 3,
            assigneeUserId: null,
            assigneeDisplayName: null,
            claimedAt: null,
          },
          {
            type: 'RELEASED',
            actorKind: 'USER',
            actorId: userId,
            actorDisplayName: 'Ana',
            fromStatus: 'IN_PROGRESS',
            toStatus: 'NEW',
            version: 3,
            data: {},
          },
          releaseAt,
        );
      });
      const released = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: row.id },
      });
      // A fresh 30-minute claim window from the release.
      expect(iso(released.claimDeadlineAt)).toBe('2026-11-10T09:10:00.000Z');
      // The resolve clock keeps counting from creation.
      expect(iso(released.resolveDeadlineAt)).toBe('2026-11-10T10:00:00.000Z');
      expect(iso(released.nextSlaCheckAt)).toBe('2026-11-10T08:55:00.000Z');
    });

    it('a settings recompute after a release keeps the restarted claim window', async () => {
      const row = await seedRequest(tenant, {
        status: 'NEW',
        slaPolicyVersion: 1,
        createdAt: new Date('2026-11-10T08:00:00Z'),
      });
      await prisma.chatbotRequestEvent.create({
        data: {
          tenantId: tenant,
          requestId: row.id,
          type: 'RELEASED',
          actorKind: 'USER',
          actorId: userId,
          actorDisplayName: 'Ana',
          fromStatus: 'IN_PROGRESS',
          toStatus: 'NEW',
          version: 2,
          data: {},
          createdAt: new Date('2026-11-10T08:40:00Z'),
        },
      });
      await recomputeOpenRequests(root, tenant, { now: () => NOW });
      const after = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(iso(after.claimDeadlineAt)).toBe('2026-11-10T09:10:00.000Z');
    });
  });

  // ------------------------------------------------------- apply to all

  describe('POST /chatbot-settings/apply-to-all-tenants (S7)', () => {
    const source = tenantA;
    let template: ReturnType<typeof ALWAYS_OPEN>;

    beforeAll(async () => {
      const current = (await get(source)).body;
      template = {
        ...ALWAYS_OPEN(),
        closedDates: ['2026-12-25'],
        receiptCloseMarginMinutes: 45,
        windowWarningMinutes: 60,
      };
      template.slas = template.slas.map((s) =>
        s.subtype === 'UNKNOWN_QUESTION'
          ? { ...s, claimMinutes: 15, resolveMinutes: 90 }
          : s,
      );
      template.scheduling = {
        enabled: true,
        slotMinutes: 20,
        slotsOffered: 2,
        maxScheduledPerSlot: 4,
      };
      template.templateName = 'plantilla_origen';
      template.templateCostText = 'Texto del origen';
      await put(source, body(template, current.version)).expect(200);
      // B keeps its own template fields and is the tenant that will change.
      await root.chatbotAttentionSettings.update({
        where: { tenantId: tenantB },
        data: { templateName: 'plantilla_b', templateCostText: 'Texto de B' },
      });
    });

    it('needs update:ChatbotSettingsAllBranches', async () => {
      await applyAll(source, {}, 'manager').expect(403);
      await applyAll(source, {}, 'viewer').expect(403);
    });

    it('dryRun reports what would change and writes nothing', async () => {
      const versionsBefore = await root.chatbotAttentionSettings.findMany({
        where: { tenantId: { in: tenants } },
        select: { tenantId: true, version: true },
        orderBy: { tenantId: 'asc' },
      });
      const res = await applyAll(source, { dryRun: true }).expect(200);
      expect(res.body.dryRun).toBe(true);
      expect(
        res.body.tenantsApplied.map((t: { tenantId: string }) => t.tenantId),
      ).toEqual([tenantB, tenantD].sort());
      expect(
        await root.chatbotAttentionSettings.findMany({
          where: { tenantId: { in: tenants } },
          select: { tenantId: true, version: true },
          orderBy: { tenantId: 'asc' },
        }),
      ).toEqual(versionsBefore);
      expect(
        await prisma.chatbotAttentionSettingsEvent.count({
          where: { type: 'APPLIED_TO_ALL' },
        }),
      ).toBe(0);
    });

    it('applies only where the caller holds the permission through a membership', async () => {
      const openInB = await seedRequest(tenantB, {
        status: 'NEW',
        slaPolicyVersion: 0,
      });
      const res = await applyAll(source).expect(200);
      const ids = (list: Array<{ tenantId: string }>) =>
        list.map((t) => t.tenantId).sort();

      // D: `manage:all` through a second membership (grants merge). B: admin.
      expect(ids(res.body.tenantsApplied)).toEqual([tenantB, tenantD].sort());
      expect(ids(res.body.tenantsUnchanged)).toEqual([tenantA]);
      const skipped = Object.fromEntries(
        res.body.tenantsSkipped.map(
          (t: { tenantId: string; reason: string }) => [t.tenantId, t.reason],
        ),
      );
      // C: member without the grant. E: grant but the branch is inactive.
      expect(skipped).toEqual({
        [tenantC]: 'NO_PERMISSION',
        [tenantE]: 'TENANT_INACTIVE',
      });
      expect(res.body.tenantsFailed).toEqual([]);

      // A tenant of nobody is neither changed nor listed (no cross-tenant leak).
      const stranger: string = randomUUID();
      await prisma.tenant.create({
        data: { id: stranger, name: 'Ajena', slug: `cs-${stranger}` },
      });
      try {
        const again = await applyAll(source).expect(200);
        expect(JSON.stringify(again.body)).not.toContain(stranger);
        expect(
          await root.chatbotAttentionSettings.count({
            where: { tenantId: stranger },
          }),
        ).toBe(0);
      } finally {
        await prisma.tenant.delete({ where: { id: stranger } });
      }

      const b = await root.chatbotAttentionSettings.findUniqueOrThrow({
        where: { tenantId: tenantB },
      });
      expect(b.closedDates).toEqual(['2026-12-25']);
      expect(b.receiptCloseMarginMinutes).toBe(45);
      expect(b.windowWarningMinutes).toBe(60);
      expect(b.schedulingEnabled).toBe(true);
      expect(b.slotMinutes).toBe(20);
      expect(b.version).toBe(6);
      // The template fields are per branch and are not copied.
      expect(b.templateName).toBe('plantilla_b');
      expect(b.templateCostText).toBe('Texto de B');

      // C and E were not touched.
      expect(
        await root.chatbotAttentionSettings.count({
          where: { tenantId: { in: [tenantC] } },
        }),
      ).toBe(1);
      const c = await root.chatbotAttentionSettings.findUniqueOrThrow({
        where: { tenantId: tenantC },
      });
      expect(c.closedDates).toEqual([]);
      const e = await root.chatbotAttentionSettings.findUniqueOrThrow({
        where: { tenantId: tenantE },
      });
      expect(e.closedDates).toEqual([]);

      // One audit event per changed tenant, naming the source.
      const events = await prisma.chatbotAttentionSettingsEvent.findMany({
        where: { type: 'APPLIED_TO_ALL' },
      });
      expect(events.map((x) => x.tenantId).sort()).toEqual(
        [tenantB, tenantD].sort(),
      );
      for (const event of events) {
        expect(event).toMatchObject({ actorUserId: userId });
        expect((event.data as { sourceTenantId: string }).sourceTenantId).toBe(
          source,
        );
      }

      // The open requests of B were recomputed with the new minutes (15 claim).
      const recomputed = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: openInB.id },
      });
      expect(recomputed.slaPolicyVersion).toBe(b.version);
      expect(iso(recomputed.claimDeadlineAt)).toBe('2026-11-10T12:15:00.000Z');
    });

    it('copies the closed-date reasons like the dates; a stale expectedVersion 409 carries updatedBy', async () => {
      const current = (await get(source)).body;
      const withReasons = {
        ...template,
        closedDateReasons: { '2026-12-25': 'Navidad' },
      };
      await put(source, body(withReasons, current.version)).expect(200);
      const res = await applyAll(source).expect(200);
      expect(
        res.body.tenantsApplied
          .map((t: { tenantId: string }) => t.tenantId)
          .sort(),
      ).toEqual([tenantB, tenantD].sort());
      for (const id of [tenantB, tenantD]) {
        const row = await root.chatbotAttentionSettings.findUniqueOrThrow({
          where: { tenantId: id },
        });
        expect(row.closedDateReasons).toEqual({ '2026-12-25': 'Navidad' });
        expect((await get(id)).body.closedDateReasons).toEqual({
          '2026-12-25': 'Navidad',
        });
      }
      const stale = await applyAll(source, { expectedVersion: 0 }).expect(409);
      expect(stale.body.current.updatedBy).toEqual({
        id: userId,
        displayName: 'Ana',
      });
      expect(typeof stale.body.current.updatedAt).toBe('string');
      expect(stale.body.current.closedDateReasons).toEqual({
        '2026-12-25': 'Navidad',
      });
      // the target shows who applied it (the caller) and when
      expect((await get(tenantB)).body.updatedBy).toEqual({
        id: userId,
        displayName: 'Ana',
      });
    });

    it('is idempotent: a second run changes nothing', async () => {
      const res = await applyAll(source).expect(200);
      expect(res.body.tenantsApplied).toEqual([]);
      expect(
        res.body.tenantsUnchanged
          .map((t: { tenantId: string }) => t.tenantId)
          .sort(),
      ).toEqual([tenantA, tenantB, tenantD].sort());
    });

    it('expectedVersion guards the source: a stale one is 409 with current', async () => {
      const res = await applyAll(source, { expectedVersion: 0 }).expect(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(res.body.current.version).toBeGreaterThan(0);
    });

    it('does not change permissions or tenant membership', async () => {
      const grantsBefore = await prisma.rolePermission.count();
      const membershipsBefore = await prisma.tenantMembership.count();
      await applyAll(source).expect(200);
      expect(await prisma.rolePermission.count()).toBe(grantsBefore);
      expect(await prisma.tenantMembership.count()).toBe(membershipsBefore);
    });

    describe('write authority comes from the CASL ability (T7d)', () => {
      afterEach(() => jest.restoreAllMocks());

      it('builds one ability per ACTIVE member tenant with the PermissionsGuard factory, and none for other tenants', async () => {
        const spy = jest.spyOn(casl, 'createForUser');
        const stranger: string = randomUUID();
        await prisma.tenant.create({
          data: { id: stranger, name: 'Ajena', slug: `cs-${stranger}` },
        });
        try {
          await applyAll(source, { dryRun: true }).expect(200);
        } finally {
          await prisma.tenant.delete({ where: { id: stranger } });
        }
        const forWrite = spy.mock.calls.filter(([, ctx]) =>
          tenants.includes(ctx.tenantId ?? ''),
        );
        expect(
          forWrite.map(([uid, ctx]) => [uid, ctx.tenantId, ctx.isSuperAdmin]),
        ).toEqual(
          [tenantA, tenantB, tenantC, tenantD]
            .sort()
            .map((id) => [userId, id, false]),
        );
        // Bounded by the memberships: nothing for the inactive E or a stranger.
        expect(spy.mock.calls.map(([, ctx]) => ctx.tenantId)).not.toContain(
          tenantE,
        );
        expect(JSON.stringify(spy.mock.calls)).not.toContain(stranger);
      });

      it('defers to the ability: a tenant whose ability denies the update is NO_PERMISSION whatever a grant scan says', async () => {
        const real: CaslAbilityFactory['createForUser'] = (uid, ctx) =>
          CaslAbilityFactory.prototype.createForUser.call(
            casl,
            uid,
            ctx,
          ) as Promise<AppAbility>;
        jest
          .spyOn(casl, 'createForUser')
          .mockImplementation((uid, ctx) =>
            ctx.tenantId === tenantB
              ? Promise.resolve(
                  new AbilityBuilder<AppAbility>(createMongoAbility).build(),
                )
              : real(uid, ctx),
          );
        const res = await applyAll(source, { dryRun: true }).expect(200);
        const skipped = Object.fromEntries(
          res.body.tenantsSkipped.map(
            (t: { tenantId: string; reason: string }) => [t.tenantId, t.reason],
          ),
        );
        expect(skipped).toEqual({
          [tenantB]: 'NO_PERMISSION',
          [tenantC]: 'NO_PERMISSION',
          [tenantE]: 'TENANT_INACTIVE',
        });
        const listed = [
          ...res.body.tenantsApplied,
          ...res.body.tenantsUnchanged,
        ].map((t: { tenantId: string }) => t.tenantId);
        expect(listed).not.toContain(tenantB);
      });

      it('a stale expectedVersion returns current only to a caller who can read:ChatbotSettings in the source tenant', async () => {
        // A's role reads the settings (seed); B's role only has the all-branches grant.
        const withRead = await applyAll(tenantA, { expectedVersion: 0 }).expect(
          409,
        );
        expect(withRead.body.code).toBe('VERSION_CONFLICT');
        expect(withRead.body.current.version).toBeGreaterThan(0);

        const withoutRead = await applyAll(tenantB, {
          expectedVersion: 0,
        }).expect(409);
        expect(withoutRead.body).toEqual({
          statusCode: 409,
          code: 'VERSION_CONFLICT',
          message: 'The settings changed; reload them',
        });
        expect(JSON.stringify(withoutRead.body)).not.toContain('openingHours');
      });
    });
  });

  // ------------------------------------------------ S11 (T7f): additions

  describe('S11: who saved, field errors, closed-date reasons', () => {
    const tenantF: string = randomUUID();
    const beto: string = randomUUID();
    const futureUser: string = randomUUID();

    beforeAll(async () => {
      await prisma.tenant.create({
        data: { id: tenantF, name: 'Sucursal F', slug: `cs-${tenantF}` },
      });
      for (const [id, name] of [
        [beto, 'Beto'],
        [futureUser, 'Carla'],
      ]) {
        await prisma.user.create({
          data: {
            id,
            email: `${id}@settings.test`,
            hashedPassword: 'x',
            name,
          },
        });
      }
    });

    afterAll(async () => {
      await prisma.tenant.delete({ where: { id: tenantF } });
      await prisma.user.deleteMany({
        where: { id: { in: [beto, futureUser] } },
      });
    });

    const putAs = (uid: string, body: object, tenantId = tenantF) =>
      request(server())
        .put('/chatbot-settings')
        .set(as('manager', tenantId, uid))
        .send(body);

    describe('updatedBy / updatedAt', () => {
      it('are null for a tenant on the defaults (no row)', async () => {
        const res = await get(tenantF).expect(200);
        expect(res.body).toMatchObject({
          version: 0,
          updatedBy: null,
          updatedAt: null,
          closedDateReasons: {},
        });
      });

      it('name the last writer, copied from the audit; PUT answers them too', async () => {
        const first = await putAs(beto, body(ALWAYS_OPEN(), 0)).expect(200);
        const event =
          await prisma.chatbotAttentionSettingsEvent.findFirstOrThrow({
            where: { tenantId: tenantF },
            orderBy: { createdAt: 'desc' },
          });
        expect(first.body.updatedBy).toEqual({ id: beto, displayName: 'Beto' });
        expect(first.body.updatedAt).toBe(event.createdAt.toISOString());
        const read = await get(tenantF).expect(200);
        expect(read.body.updatedBy).toEqual({ id: beto, displayName: 'Beto' });
        expect(read.body.updatedAt).toBe(first.body.updatedAt);

        const second = await putAs(
          userId,
          body({ ...ALWAYS_OPEN(), windowWarningMinutes: 45 }, 1),
        ).expect(200);
        expect(second.body.updatedBy).toEqual({
          id: userId,
          displayName: 'Ana',
        });
        expect(
          new Date(second.body.updatedAt).getTime(),
        ).toBeGreaterThanOrEqual(new Date(first.body.updatedAt).getTime());
      });

      it('an identical PUT is a no-op and keeps who and when', async () => {
        const before = (await get(tenantF)).body;
        const same = await putAs(
          beto,
          body({ ...ALWAYS_OPEN(), windowWarningMinutes: 45 }, 2),
        ).expect(200);
        expect(same.body.version).toBe(2);
        expect(same.body.updatedBy).toEqual(before.updatedBy);
        expect(same.body.updatedAt).toBe(before.updatedAt);
      });

      it('the 409 current carries them', async () => {
        const res = await putAs(beto, body(ALWAYS_OPEN(), 0)).expect(409);
        expect(res.body.current.updatedBy).toEqual({
          id: userId,
          displayName: 'Ana',
        });
        expect(typeof res.body.current.updatedAt).toBe('string');
      });

      it('survive the deletion of the user (the name is the stored copy)', async () => {
        await putAs(
          futureUser,
          body({ ...ALWAYS_OPEN(), windowWarningMinutes: 50 }, 2),
        ).expect(200);
        await prisma.user.delete({ where: { id: futureUser } });
        const res = await get(tenantF).expect(200);
        expect(res.body.updatedBy).toEqual({
          id: futureUser,
          displayName: 'Carla',
        });
      });
    });

    describe('closedDateReasons', () => {
      const withReasons = (reasons?: Record<string, string>) => ({
        ...ALWAYS_OPEN(),
        windowWarningMinutes: 50,
        closedDates: ['2026-12-25', '2026-01-01'],
        ...(reasons ? { closedDateReasons: reasons } : {}),
      });

      it('are stored with the dates, returned by GET and PUT, closedDates stays string[]', async () => {
        const res = await putAs(
          beto,
          body(
            withReasons({ '2026-12-25': 'Navidad', '2026-01-01': 'Año nuevo' }),
            3,
          ),
        ).expect(200);
        expect(res.body.closedDates).toEqual(['2026-01-01', '2026-12-25']);
        expect(res.body.closedDateReasons).toEqual({
          '2026-01-01': 'Año nuevo',
          '2026-12-25': 'Navidad',
        });
        const read = (await get(tenantF).expect(200)).body;
        expect(read.closedDateReasons).toEqual(res.body.closedDateReasons);
        expect(read.version).toBe(4);
      });

      it('changing only a reason is a real change (version +1); the same map is a no-op', async () => {
        const changed = await putAs(
          beto,
          body(
            withReasons({ '2026-12-25': 'Feriado', '2026-01-01': 'Año nuevo' }),
            4,
          ),
        ).expect(200);
        expect(changed.body.version).toBe(5);
        const same = await putAs(
          beto,
          // another key order, same content
          body(
            withReasons({ '2026-01-01': 'Año nuevo', '2026-12-25': 'Feriado' }),
            5,
          ),
        ).expect(200);
        expect(same.body.version).toBe(5);
      });

      it('a reason for a date that is not closed is a 400 with fieldErrors, nothing saved', async () => {
        const res = await putAs(
          beto,
          body(withReasons({ '2026-12-24': 'Nochebuena' }), 5),
        ).expect(400);
        expect(res.body).toMatchObject({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          reason: 'INVALID_CHATBOT_SETTINGS',
          fieldErrors: [
            {
              path: 'closedDateReasons["2026-12-24"]',
              code: 'REASON_WITHOUT_DATE',
            },
          ],
        });
        expect((await get(tenantF)).body.version).toBe(5);
      });

      it('omitting closedDateReasons clears them (a PUT replaces the object)', async () => {
        const res = await putAs(beto, body(withReasons(), 5)).expect(200);
        expect(res.body.closedDateReasons).toEqual({});
        expect(res.body.version).toBe(6);
      });

      it('a reason of 81 characters or an empty one is INVALID_LENGTH', async () => {
        const res = await putAs(
          beto,
          body(
            withReasons({ '2026-12-25': 'x'.repeat(81), '2026-01-01': ' ' }),
            6,
          ),
        ).expect(400);
        expect(res.body.fieldErrors).toEqual(
          expect.arrayContaining([
            {
              path: 'closedDateReasons["2026-12-25"]',
              code: 'INVALID_LENGTH',
            },
            {
              path: 'closedDateReasons["2026-01-01"]',
              code: 'INVALID_LENGTH',
            },
          ]),
        );
      });
    });

    describe('400 VALIDATION_ERROR carries fieldErrors', () => {
      const bad = async (body: object) => {
        const res = await putAs(beto, body).expect(400);
        return res.body as Record<string, any>;
      };

      it('a domain rule: same statusCode/code/reason/message as before plus the located list', async () => {
        const settings = ALWAYS_OPEN();
        settings.openingHours.days[1].ranges = [
          { open: '09:00', close: '14:00' },
          { open: '13:00', close: '18:00' },
        ];
        expect(await bad(body(settings, 6))).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          reason: 'INVALID_OPENING_HOURS',
          message: 'TUESDAY: ranges must not overlap or touch',
          fieldErrors: [
            { path: 'openingHours.days[1].ranges[1]', code: 'OVERLAP' },
          ],
        });
      });

      it('reports several problems at once, each with its path', async () => {
        const settings = ALWAYS_OPEN();
        settings.openingHours.timeZone = 'Mars/Olympus';
        settings.openingHours.days[0].ranges = [
          { open: '22:00', close: '02:00' },
        ];
        settings.closedDates = ['2026-12-25', '2026-02-30'];
        settings.slas[5].claimMinutes = 100;
        settings.slas[5].resolveMinutes = 50;
        settings.slas[3].resolveMinutes = 10;
        const res = await bad(body(settings, 6));
        expect(res.fieldErrors).toEqual(
          expect.arrayContaining([
            { path: 'openingHours.timeZone', code: 'INVALID_TIMEZONE' },
            {
              path: 'openingHours.days[0].ranges[0]',
              code: 'CROSSES_MIDNIGHT',
            },
            { path: 'closedDates[1]', code: 'INVALID_DATE' },
            { path: 'slas[5].resolveMinutes', code: 'RESOLVE_BELOW_CLAIM' },
            { path: 'slas[3].resolveMinutes', code: 'MUST_BE_NULL' },
          ]),
        );
        expect(res.fieldErrors).toHaveLength(5);
      });

      it('shape errors (the DTO) get paths and codes too, with the generic envelope unchanged', async () => {
        const settings = ALWAYS_OPEN();
        settings.openingHours.days[2].ranges = [
          { open: '9:00', close: '10:00' },
        ];
        const res = await bad(body(settings, 6));
        expect(res).toMatchObject({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          fieldErrors: [
            {
              path: 'openingHours.days[2].ranges[0].open',
              code: 'INVALID_TIME',
            },
          ],
        });
        expect(res.reason).toBeUndefined();
      });

      it('more than 6 ranges in a day is TOO_MANY_RANGES (settings), the 7th is the error', async () => {
        const settings = ALWAYS_OPEN();
        settings.openingHours.days[3].ranges = Array.from(
          { length: 7 },
          (_, n) => ({
            open: `${String(n * 3).padStart(2, '0')}:00`,
            close: `${String(n * 3).padStart(2, '0')}:30`,
          }),
        );
        expect((await bad(body(settings, 6))).fieldErrors).toEqual([
          { path: 'openingHours.days[3].ranges', code: 'TOO_MANY_RANGES' },
        ]);
      });

      it('missing, mistyped, out of range and unknown fields', async () => {
        const settings: Record<string, unknown> = {
          ...ALWAYS_OPEN(),
          tenantId: tenantA,
          windowWarningMinutes: 'soon',
        };
        delete settings.receiptCloseMarginMinutes;
        const res = await bad(settings);
        expect(res.fieldErrors).toEqual(
          expect.arrayContaining([
            { path: 'expectedVersion', code: 'REQUIRED' },
            { path: 'receiptCloseMarginMinutes', code: 'REQUIRED' },
            { path: 'windowWarningMinutes', code: 'INVALID_TYPE' },
            { path: 'tenantId', code: 'UNKNOWN_FIELD' },
          ]),
        );
        const negative = await bad(body(ALWAYS_OPEN(), -1));
        expect(negative.fieldErrors).toEqual([
          { path: 'expectedVersion', code: 'OUT_OF_RANGE' },
        ]);
      });

      it('never echoes what the caller sent', async () => {
        const settings = ALWAYS_OPEN();
        settings.templateCostText = 'SECRETO-123\u0000';
        const res = await bad(body(settings, 6));
        expect(JSON.stringify(res)).not.toContain('SECRETO-123');
      });

      it('apply-to-all validates its body the same way', async () => {
        const res = await applyAll(
          tenantA,
          { dryRun: 'yes', expectedVersion: -1, extra: 1 },
          'admin',
        ).expect(400);
        expect(res.body).toMatchObject({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
        expect(res.body.fieldErrors).toEqual(
          expect.arrayContaining([
            { path: 'dryRun', code: 'INVALID_TYPE' },
            { path: 'expectedVersion', code: 'OUT_OF_RANGE' },
            { path: 'extra', code: 'UNKNOWN_FIELD' },
          ]),
        );
      });
    });
  });

  // -------------------------- a committed write whose recompute fails

  describe('recompute failure after a committed write', () => {
    const real = recomputeModule.recomputeOpenRequests;
    let loggerError: jest.SpyInstance;

    beforeEach(() => {
      loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it('PUT answers 200 with the saved settings and recompute FAILED; the write stays and is logged', async () => {
      const tenant: string = randomUUID();
      await prisma.tenant.create({
        data: { id: tenant, name: 'Falla PUT', slug: `cs-${tenant}` },
      });
      try {
        const open = await seedRequest(tenant, { status: 'NEW' });
        jest
          .spyOn(recomputeModule, 'recomputeOpenRequests')
          .mockRejectedValueOnce(new Error('boom: connection reset'));

        const res = await put(tenant, body(ALWAYS_OPEN(), 0)).expect(200);
        expect(res.body.version).toBe(1);
        expect(res.body.openingHours.timeZone).toBe('UTC');
        expect(res.body.recompute).toBe('FAILED');
        expect(loggerError).toHaveBeenCalledWith(
          expect.stringContaining(tenant),
        );
        expect(JSON.stringify(loggerError.mock.calls)).not.toContain('boom');

        // The write is committed; the request still carries the old deadlines.
        const saved = await root.chatbotAttentionSettings.findUniqueOrThrow({
          where: { tenantId: tenant },
        });
        expect(saved.version).toBe(1);
        expect(
          (
            await prisma.chatbotRequest.findUniqueOrThrow({
              where: { id: open.id },
            })
          ).slaPolicyVersion,
        ).toBe(0);

        // A retry with the old version is the normal CAS conflict.
        await put(tenant, body(ALWAYS_OPEN(), 0)).expect(409);
        // Re-saving the same content is a no-op and does not recompute.
        const again = await put(tenant, body(ALWAYS_OPEN(), 1)).expect(200);
        expect(again.body.version).toBe(1);
        expect(again.body.recompute).toBe('NOT_NEEDED');
      } finally {
        await prisma.tenant.delete({ where: { id: tenant } });
      }
    });

    it('PUT reports recompute DONE when it works', async () => {
      const tenant: string = randomUUID();
      await prisma.tenant.create({
        data: { id: tenant, name: 'Ok PUT', slug: `cs-${tenant}` },
      });
      try {
        const res = await put(tenant, body(ALWAYS_OPEN(), 0)).expect(200);
        expect(res.body.recompute).toBe('DONE');
      } finally {
        await prisma.tenant.delete({ where: { id: tenant } });
      }
    });

    it('apply-to-all lists a tenant whose recompute failed once, in tenantsApplied with recompute FAILED', async () => {
      const source = tenantA;
      const current = (await get(source)).body;
      const changed = {
        ...ALWAYS_OPEN(),
        closedDates: current.closedDates,
        windowWarningMinutes: current.windowWarningMinutes + 7,
        receiptCloseMarginMinutes: current.receiptCloseMarginMinutes + 7,
      };
      await put(source, body(changed, current.version)).expect(200);
      const stuck = await seedRequest(tenantB, { status: 'NEW' });
      jest
        .spyOn(recomputeModule, 'recomputeOpenRequests')
        .mockImplementation((db, tenantId, options) =>
          tenantId === tenantB
            ? Promise.reject(new Error('boom'))
            : real(db, tenantId, options),
        );

      const res = await applyAll(source).expect(200);
      const lists = {
        applied: res.body.tenantsApplied,
        unchanged: res.body.tenantsUnchanged,
        skipped: res.body.tenantsSkipped,
        failed: res.body.tenantsFailed,
      };
      const everyId = Object.values(lists)
        .flat()
        .map((t: { tenantId: string }) => t.tenantId);
      expect(new Set(everyId).size).toBe(everyId.length);
      const applied = Object.fromEntries(
        lists.applied.map((t: { tenantId: string; recompute: string }) => [
          t.tenantId,
          t.recompute,
        ]),
      );
      expect(applied).toEqual({ [tenantB]: 'FAILED', [tenantD]: 'DONE' });
      expect(lists.failed).toEqual([]);

      // B's settings are committed; its open request is still stale.
      const b = await root.chatbotAttentionSettings.findUniqueOrThrow({
        where: { tenantId: tenantB },
      });
      expect(b.windowWarningMinutes).toBe(changed.windowWarningMinutes);
      expect(
        (
          await prisma.chatbotRequest.findUniqueOrThrow({
            where: { id: stuck.id },
          })
        ).slaPolicyVersion,
      ).toBeLessThan(b.version);
    });
  });

  // ---------------------- a create that read the defaults vs the first PUT

  describe('create that read the defaults vs the first PUT of a tenant without a row', () => {
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    const newTenant = async (label: string) => {
      const id: string = randomUUID();
      await prisma.tenant.create({
        data: { id, name: label, slug: `cs-${id}` },
      });
      return id;
    };

    const requestData = (tenantId: string, folio: number) => ({
      tenantId,
      folio,
      kind: 'CLARIFICATION' as const,
      subtype: 'UNKNOWN_QUESTION' as const,
      customerKey: `5255300${String(folio).padStart(5, '0')}`,
      summary: 'Carrera',
      source: 'chatbot',
      sourceRequestId: randomUUID(),
    });

    it('a create that read version 0 and commits after the first PUT is recomputed, never left on the defaults', async () => {
      const tenant = await newTenant('Carrera 1');
      try {
        let readDefaults!: () => void;
        const defaultsRead = new Promise<void>((r) => (readDefaults = r));
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        type Columns = {
          claimDeadlineAt: Date | null;
          resolveDeadlineAt: Date | null;
        };
        let captured: Columns | null = null;

        // The create (as the wrapper does): reads the policy, then inserts later.
        const create = root.$transaction(
          async (tx) => {
            const client = tx as never;
            const folio = await allocateFolio(client, tenant);
            const sla = await slaColumnsForNew(
              client,
              tenant,
              { subtype: 'UNKNOWN_QUESTION' },
              NOW,
            );
            expect(sla.slaPolicyVersion).toBe(0);
            captured = sla;
            readDefaults();
            await gate;
            return insertRequestOnDedup(client, {
              ...requestData(tenant, folio),
              ...sla,
            } as never);
          },
          { timeout: 30_000 },
        );
        await defaultsRead;

        // The first PUT starts while the create holds the defaults.
        let putSettled = false;
        const putDone = put(tenant, body(ALWAYS_OPEN(), 0)).then((res) => {
          putSettled = true;
          return res;
        });
        await sleep(500);
        // It must wait for the create (so its recompute can see the row).
        expect(putSettled).toBe(false);

        release();
        const id = await create;
        const res = await putDone;
        expect(res.status).toBe(200);
        expect(res.body.recompute).toBe('DONE');

        const row = await prisma.chatbotRequest.findUniqueOrThrow({
          where: { id: id! },
        });
        expect(row.slaPolicyVersion).toBe(1);
        // ALWAYS_OPEN UTC: 30 claim / 120 resolve BUSINESS minutes counted from
        // createdAt (real `now()`), so the expectation is computed with the same
        // calendar instead of assuming plain minute sums: the calendar has a
        // 23:59-00:00 gap, so a window that crosses midnight UTC is a minute
        // longer (this test failed after ~21:59 UTC with fixed 30/120).
        const expected = policyFromSettings(
          { ...defaultSettings(), ...ALWAYS_OPEN() },
          1,
        ).calendar;
        expect(row.claimDeadlineAt!.getTime()).toBe(
          expected.addBusinessMinutes(row.createdAt, 30).getTime(),
        );
        expect(row.resolveDeadlineAt!.getTime()).toBe(
          expected.addBusinessMinutes(row.createdAt, 120).getTime(),
        );
        // ...and it is NOT what the create wrote with the defaults (computed from
        // the fixed NOW, a different instant than the row's real createdAt), so
        // the recompute really ran. Unlike a comparison with the defaults at
        // the row's own createdAt, this cannot pass by coincidence of the hour.
        const createdWith = captured as Columns | null;
        expect(createdWith).not.toBeNull();
        expect(row.claimDeadlineAt!.getTime()).not.toBe(
          createdWith!.claimDeadlineAt!.getTime(),
        );
        expect(row.resolveDeadlineAt!.getTime()).not.toBe(
          createdWith!.resolveDeadlineAt!.getTime(),
        );
      } finally {
        await prisma.tenant.delete({ where: { id: tenant } });
      }
    }, 60_000);

    it('creates and first PUTs racing in any order always end on version 1', async () => {
      for (let round = 0; round < 6; round++) {
        const tenant = await newTenant(`Carrera ${round}`);
        try {
          // Both entry orders exist: the direct create takes the folio first
          // and reads the policy in the insert; the wrapper reads the policy
          // first. Mixing them must never form a lock cycle with the PUT.
          const creators = Array.from({ length: 3 }, (_, i) =>
            root.$transaction(async (tx) => {
              const client = tx as never;
              const customerKey = `5255400${randomUUID().slice(0, 8)}`;
              if (i % 2 === 0) {
                return insertRequestOnDedup(client, {
                  ...requestData(tenant, await allocateFolio(client, tenant)),
                  customerKey,
                } as never);
              }
              const sla = await slaColumnsForNew(client, tenant, {
                subtype: 'UNKNOWN_QUESTION',
              });
              return insertRequestOnDedup(client, {
                ...requestData(tenant, await allocateFolio(client, tenant)),
                customerKey,
                ...sla,
              } as never);
            }),
          );
          const [res] = await Promise.all([
            put(tenant, body(ALWAYS_OPEN(), 0)),
            ...creators,
          ]);
          expect(res.status).toBe(200);
          const rows = await prisma.chatbotRequest.findMany({
            where: { tenantId: tenant },
          });
          expect(rows).toHaveLength(3);
          for (const row of rows) {
            expect(row.slaPolicyVersion).toBe(1);
            // A create after the PUT stamps from the app clock, a recompute from
            // createdAt: both are the new 30-minute window (a few ms apart).
            const claimMs =
              row.claimDeadlineAt!.getTime() - row.createdAt.getTime();
            expect(Math.abs(claimMs - 30 * 60_000)).toBeLessThan(5_000);
          }
        } finally {
          await prisma.tenant.delete({ where: { id: tenant } });
        }
      }
    }, 60_000);

    it('a tenant that already has a row adds no write to a create', async () => {
      const tenant = await newTenant('Con fila');
      try {
        await put(tenant, body(ALWAYS_OPEN(), 0)).expect(200);
        const before = await root.chatbotAttentionSettings.findUniqueOrThrow({
          where: { tenantId: tenant },
        });
        await root.$transaction(async (tx) => {
          const client = tx as never;
          return insertRequestOnDedup(
            client,
            requestData(tenant, await allocateFolio(client, tenant)) as never,
          );
        });
        const after = await root.chatbotAttentionSettings.findUniqueOrThrow({
          where: { tenantId: tenant },
        });
        expect(after.version).toBe(before.version);
        expect(after.updatedAt.toISOString()).toBe(
          before.updatedAt.toISOString(),
        );
      } finally {
        await prisma.tenant.delete({ where: { id: tenant } });
      }
    });
  });
});
