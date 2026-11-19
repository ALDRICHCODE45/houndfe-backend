/**
 * cash-redesign-reads T1 (S2, S3, S4, S5) over real PostgreSQL:
 *   - handover recipients (grants via role and manage:all, inactive, other
 *     tenant, self per handover kind, permission denial, no PII);
 *   - GET /cash-sessions `statuses` / `drawerOpen` filters with own vs audit
 *     visibility and the `pendingOnly` intersection;
 *   - GET /cash-closings `cashierUserId`;
 *   - DB-side pagination equivalence against the per-row visibility path.
 */
import { randomUUID } from 'node:crypto';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import type { CashSessionStatus, PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  integrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type {
  CashActor,
  CashDocument,
  CashQuery,
} from '../cash-application.port';
import { PrismaCashRegisterApplication } from './prisma-cash-register';

type Grant = [AppActions, AppSubjects];
type ConditionalGrant = [AppActions, AppSubjects, Record<string, unknown>?];

const asList = (value: unknown): Record<string, unknown>[] =>
  value as Record<string, unknown>[];
const ids = (doc: CashDocument): string[] =>
  asList(doc.items).map((item) => item.id as string);

const OTHER_TENANT_ID = '00000000-0000-0000-0000-0000000000b2';

describe('cash redesign reads (PostgreSQL)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = integrationPrisma();
    await prisma.$connect();
  });

  beforeEach(async () => {
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await resetAndSeedBaseline();
    await disconnectIntegrationPrisma();
  });

  function application(tenantId: string): PrismaCashRegisterApplication {
    const store = new Map<string, unknown>([
      ['tenantId', tenantId],
      ['isSuperAdmin', false],
    ]);
    // SAFETY: TenantPrismaService uses only get/set on the CLS store.
    const cls = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    } as unknown as ClsService<TenantClsStore>;
    // SAFETY: PrismaService extends PrismaClient; no Nest lifecycle needed.
    const tenant = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls,
    );
    return new PrismaCashRegisterApplication(tenant);
  }

  function abilityOf(grants: readonly ConditionalGrant[]): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const [action, subject, conditions] of grants) {
      if (conditions) {
        can(action, subject, conditions);
      } else {
        can(action, subject);
      }
    }
    return build();
  }

  async function permissionId(action: string, subject: string) {
    const row = await prisma.permission.upsert({
      where: { subject_action: { subject, action } },
      create: { subject, action },
      update: {},
    });
    return row.id;
  }

  /**
   * Persist an active (or inactive) member whose DB role carries `dbGrants`
   * and return an actor whose in-memory ability is `abilityGrants`.
   */
  async function member(
    tenantId: string,
    name: string,
    options: {
      dbGrants?: readonly Grant[];
      roleName?: string;
      isActive?: boolean;
      abilityGrants?: readonly ConditionalGrant[];
    } = {},
  ): Promise<CashActor> {
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@cash-redesign.invalid`,
        name,
        hashedPassword: 'not-a-password',
        isActive: options.isActive ?? true,
      },
    });
    const role = await prisma.role.create({
      data: { name: options.roleName ?? `role-${randomUUID()}`, tenantId },
    });
    for (const [action, subject] of options.dbGrants ?? []) {
      await prisma.rolePermission.create({
        data: {
          roleId: role.id,
          permissionId: await permissionId(action, subject),
        },
      });
    }
    await prisma.tenantMembership.create({
      data: { tenantId, userId, roleId: role.id },
    });
    return {
      userId,
      ability: abilityOf(options.abilityGrants ?? [['manage', 'all']]),
    };
  }

  // ── S2 — handover recipients ─────────────────────────────────────────

  describe('handover recipients', () => {
    async function recipients(
      actor: CashActor,
      handoverKind: 'WITHDRAWAL' | 'FLOAT',
    ): Promise<Record<string, unknown>[]> {
      const doc = await application(BASELINE_TENANT_ID).query(actor, {
        kind: 'HANDOVER_RECIPIENTS',
        handoverKind,
      });
      return asList(doc.items);
    }

    it('lists active members granted update:CashHandover via a role or manage:all, sorted by name, without PII', async () => {
      const sender = await member(BASELINE_TENANT_ID, 'Ana Cajera', {
        abilityGrants: [['create', 'CashHandover']],
      });
      const supervisor = await member(BASELINE_TENANT_ID, 'Luis Supervisor', {
        dbGrants: [['update', 'CashHandover']],
        roleName: 'Supervisor',
      });
      const admin = await member(BASELINE_TENANT_ID, 'Beatriz Admin', {
        dbGrants: [['manage', 'all']],
        roleName: 'Administrador',
      });
      await member(BASELINE_TENANT_ID, 'Carlos Lector', {
        dbGrants: [['read', 'CashHandover']],
      });
      await member(BASELINE_TENANT_ID, 'Sin Permisos');

      const items = await recipients(sender, 'WITHDRAWAL');

      expect(items).toEqual([
        {
          userId: admin.userId,
          displayName: 'Beatriz Admin',
          roleName: 'Administrador',
        },
        {
          userId: supervisor.userId,
          displayName: 'Luis Supervisor',
          roleName: 'Supervisor',
        },
      ]);
    });

    it('excludes inactive users and members of another tenant', async () => {
      const sender = await member(BASELINE_TENANT_ID, 'Ana Cajera');
      await prisma.tenant.create({
        data: { id: OTHER_TENANT_ID, name: 'Otra', slug: 'otra-sucursal' },
      });
      await member(BASELINE_TENANT_ID, 'Inactivo', {
        dbGrants: [['update', 'CashHandover']],
        isActive: false,
      });
      await member(OTHER_TENANT_ID, 'Otra Sucursal', {
        dbGrants: [['update', 'CashHandover']],
      });
      const active = await member(BASELINE_TENANT_ID, 'Activo', {
        dbGrants: [['update', 'CashHandover']],
      });

      const items = await recipients(sender, 'FLOAT');

      expect(items.map((item) => item.userId)).toEqual([active.userId]);
    });

    it('excludes the sender for WITHDRAWAL (self-withdrawal is forbidden) but keeps them for FLOAT', async () => {
      const sender = await member(BASELINE_TENANT_ID, 'Ana Cajera', {
        dbGrants: [
          ['create', 'CashHandover'],
          ['update', 'CashHandover'],
        ],
        roleName: 'Cajera',
      });
      const other = await member(BASELINE_TENANT_ID, 'Luis Supervisor', {
        dbGrants: [['update', 'CashHandover']],
        roleName: 'Supervisor',
      });

      const withdrawal = await recipients(sender, 'WITHDRAWAL');
      const float = await recipients(sender, 'FLOAT');

      expect(withdrawal.map((item) => item.userId)).toEqual([other.userId]);
      expect(float.map((item) => item.userId)).toEqual([
        sender.userId,
        other.userId,
      ]);
    });

    it('denies a caller without create:CashHandover', async () => {
      const reader = await member(BASELINE_TENANT_ID, 'Solo Lectura', {
        abilityGrants: [
          ['read', 'CashHandover'],
          ['update', 'CashHandover'],
        ],
      });

      await expect(recipients(reader, 'FLOAT')).rejects.toMatchObject({
        code: 'CASH_PERMISSION_DENIED',
      });
    });
  });

  // ── S3 / S4 / S5 fixtures ───────────────────────────────────────────

  interface SessionSeed {
    cashier: string;
    status: CashSessionStatus;
    released: boolean;
  }

  async function seedSessions(seeds: readonly SessionSeed[]) {
    const base = Date.parse('2026-11-01T10:00:00.000Z');
    const created: string[] = [];
    for (const [index, seed] of seeds.entries()) {
      const register = await prisma.cashRegister.create({
        data: { tenantId: BASELINE_TENANT_ID, name: `Caja ${index}` },
      });
      const openedAt = new Date(base + index * 60_000);
      const session = await prisma.cashSession.create({
        data: {
          tenantId: BASELINE_TENANT_ID,
          registerId: register.id,
          cashierUserId: seed.cashier,
          openingCents: 0,
          status: seed.status,
          openedAt,
          drawerReleasedAt: seed.released
            ? new Date(openedAt.getTime() + 1000)
            : null,
          closedAt:
            seed.status === 'CLOSED'
              ? new Date(openedAt.getTime() + 2000)
              : null,
        },
      });
      created.push(session.id);
    }
    return created;
  }

  async function sessionsQuery(
    actor: CashActor,
    extra: Omit<Extract<CashQuery, { kind: 'SESSIONS' }>, 'kind' | 'page'> & {
      page?: Extract<CashQuery, { kind: 'SESSIONS' }>['page'];
    },
  ): Promise<CashDocument> {
    return application(BASELINE_TENANT_ID).query(actor, {
      kind: 'SESSIONS',
      page: extra.page ?? {},
      ...extra,
    });
  }

  // ── S3 — status / drawerOpen filters ────────────────────────────────

  describe('session status and drawerOpen filters', () => {
    async function fixture() {
      const cashierA = await member(BASELINE_TENANT_ID, 'Cajera A', {
        abilityGrants: [['read', 'CashSession']],
      });
      const cashierB = await member(BASELINE_TENANT_ID, 'Cajero B');
      const auditor = await member(BASELINE_TENANT_ID, 'Auditor', {
        abilityGrants: [
          ['read', 'CashSession'],
          ['read', 'CashSessionAudit'],
        ],
      });
      const [a1, a2, a3, a4, b1, b2] = await seedSessions([
        { cashier: cashierA.userId, status: 'OPEN', released: false },
        { cashier: cashierA.userId, status: 'COUNTING', released: false },
        { cashier: cashierA.userId, status: 'SUBMITTED', released: true },
        { cashier: cashierA.userId, status: 'CLOSED', released: true },
        { cashier: cashierB.userId, status: 'OPEN', released: false },
        { cashier: cashierB.userId, status: 'SUBMITTED', released: false },
      ]);
      return { cashierA, cashierB, auditor, a1, a2, a3, a4, b1, b2 };
    }

    it('filters by one or many exact statuses (audit sees every cashier)', async () => {
      const f = await fixture();

      const open = await sessionsQuery(f.auditor, { statuses: ['OPEN'] });
      const done = await sessionsQuery(f.auditor, {
        statuses: ['SUBMITTED', 'CLOSED'],
      });

      expect(ids(open)).toEqual([f.b1, f.a1]);
      expect(open.total).toBe(2);
      expect(ids(done)).toEqual([f.b2, f.a4, f.a3]);
      expect(done.total).toBe(3);
    });

    it('filters by drawerOpen (drawerReleasedAt null vs not null)', async () => {
      const f = await fixture();

      const open = await sessionsQuery(f.auditor, { drawerOpen: true });
      const released = await sessionsQuery(f.auditor, { drawerOpen: false });

      expect(ids(open)).toEqual([f.b2, f.b1, f.a2, f.a1]);
      expect(ids(released)).toEqual([f.a4, f.a3]);
    });

    it('combines status, drawerOpen and cashierUserId; pendingOnly intersects with status', async () => {
      const f = await fixture();

      const combined = await sessionsQuery(f.auditor, {
        page: { cashierUserId: f.cashierB.userId },
        statuses: ['SUBMITTED'],
        drawerOpen: true,
      });
      const pending = await sessionsQuery(f.auditor, {
        pendingOnly: true,
        statuses: ['OPEN', 'SUBMITTED'],
      });
      const disjoint = await sessionsQuery(f.auditor, {
        pendingOnly: true,
        statuses: ['OPEN'],
      });

      expect(ids(combined)).toEqual([f.b2]);
      expect(ids(pending)).toEqual([f.b2, f.a3]);
      expect(ids(disjoint)).toEqual([]);
      expect(disjoint.total).toBe(0);
    });

    it('keeps own-only visibility without read:CashSessionAudit', async () => {
      const f = await fixture();

      const own = await sessionsQuery(f.cashierA, {
        statuses: ['OPEN', 'SUBMITTED'],
      });
      const drawer = await sessionsQuery(f.cashierA, { drawerOpen: true });
      const foreign = await sessionsQuery(f.cashierA, {
        page: { cashierUserId: f.cashierB.userId },
        statuses: ['OPEN'],
      });

      expect(ids(own)).toEqual([f.a3, f.a1]);
      expect(own.total).toBe(2);
      expect(ids(drawer)).toEqual([f.a2, f.a1]);
      expect(ids(foreign)).toEqual([]);
      expect(foreign.total).toBe(0);
    });
  });

  // ── S4 — closings cashierUserId ─────────────────────────────────────

  async function seedClosings(
    sessionIds: readonly string[],
    closedBy: string,
  ): Promise<string[]> {
    const base = Date.parse('2026-11-02T10:00:00.000Z');
    const created: string[] = [];
    for (const [index, sessionId] of sessionIds.entries()) {
      const closing = await prisma.cashClosing.create({
        data: {
          tenantId: BASELINE_TENANT_ID,
          sessionId,
          folio: `F-${index}-${randomUUID()}`,
          closedByUserId: closedBy,
          snapshotJson: {},
          createdAt: new Date(base + index * 60_000),
        },
      });
      created.push(closing.id);
    }
    return created;
  }

  describe('closings cashierUserId filter', () => {
    it('returns only closings whose closed session belongs to that cashier', async () => {
      const cashierA = await member(BASELINE_TENANT_ID, 'Cajera A');
      const cashierB = await member(BASELINE_TENANT_ID, 'Cajero B');
      const closer = await member(BASELINE_TENANT_ID, 'Supervisor', {
        abilityGrants: [
          ['read', 'CashClosing'],
          ['read', 'CashSessionAudit'],
        ],
      });
      const sessions = await seedSessions([
        { cashier: cashierA.userId, status: 'CLOSED', released: true },
        { cashier: cashierB.userId, status: 'CLOSED', released: true },
        { cashier: cashierA.userId, status: 'CLOSED', released: true },
      ]);
      const [c1, , c3] = await seedClosings(sessions, closer.userId);
      const app = application(BASELINE_TENANT_ID);

      const filtered = await app.query(closer, {
        kind: 'CLOSINGS',
        page: { cashierUserId: cashierA.userId },
      });
      const unfiltered = await app.query(closer, {
        kind: 'CLOSINGS',
        page: {},
      });

      expect(ids(filtered)).toEqual([c3, c1]);
      expect(filtered.total).toBe(2);
      expect(unfiltered.total).toBe(3);
    });

    it('still scopes a non-audit reader to their own closings', async () => {
      const cashierA = await member(BASELINE_TENANT_ID, 'Cajera A', {
        abilityGrants: [['read', 'CashClosing']],
      });
      const cashierB = await member(BASELINE_TENANT_ID, 'Cajero B');
      const closer = await member(BASELINE_TENANT_ID, 'Supervisor');
      const sessions = await seedSessions([
        { cashier: cashierA.userId, status: 'CLOSED', released: true },
        { cashier: cashierB.userId, status: 'CLOSED', released: true },
      ]);
      const [c1] = await seedClosings(sessions, closer.userId);
      const app = application(BASELINE_TENANT_ID);

      const own = await app.query(cashierA, {
        kind: 'CLOSINGS',
        page: { cashierUserId: cashierA.userId },
      });
      const foreign = await app.query(cashierA, {
        kind: 'CLOSINGS',
        page: { cashierUserId: cashierB.userId },
      });

      expect(ids(own)).toEqual([c1]);
      expect(ids(foreign)).toEqual([]);
      expect(foreign.total).toBe(0);
    });

    it('shows a non-audit reader the closings they closed on another cashier session (OWN, DB path)', async () => {
      const cashierA = await member(BASELINE_TENANT_ID, 'Cajera A', {
        abilityGrants: [['read', 'CashClosing']],
      });
      const cashierB = await member(BASELINE_TENANT_ID, 'Cajero B');
      const closer = await member(BASELINE_TENANT_ID, 'Supervisor');
      const sessions = await seedSessions([
        { cashier: cashierB.userId, status: 'CLOSED', released: true },
        { cashier: cashierB.userId, status: 'CLOSED', released: true },
        { cashier: cashierA.userId, status: 'CLOSED', released: true },
      ]);
      const [closedByA] = await seedClosings([sessions[0]], cashierA.userId);
      const [foreign, ownSession] = await seedClosings(
        [sessions[1], sessions[2]],
        closer.userId,
      );
      const app = application(BASELINE_TENANT_ID);

      const all = await app.query(cashierA, { kind: 'CLOSINGS', page: {} });
      const byB = await app.query(cashierA, {
        kind: 'CLOSINGS',
        page: { cashierUserId: cashierB.userId },
      });

      expect(new Set(ids(all))).toEqual(new Set([closedByA, ownSession]));
      expect(ids(all)).not.toContain(foreign);
      expect(all.total).toBe(2);
      expect(ids(byB)).toEqual([closedByA]);
      expect(byB.total).toBe(1);
    });
  });

  // ── S5 — DB pagination equivalence with the per-row path ────────────

  describe('pagination equivalence (DB-side vs per-row visibility)', () => {
    it('returns identical pages, totals and ordering for sessions and closings', async () => {
      const cashierA = await member(BASELINE_TENANT_ID, 'Cajera A');
      const cashierB = await member(BASELINE_TENANT_ID, 'Cajero B');
      const seeds: SessionSeed[] = [];
      const statuses: CashSessionStatus[] = [
        'CLOSED',
        'SUBMITTED',
        'CLOSED',
        'COUNTING',
        'CLOSED',
        'OPEN',
        'CLOSED',
      ];
      for (const [index, status] of statuses.entries()) {
        seeds.push({
          cashier: index % 2 === 0 ? cashierA.userId : cashierB.userId,
          status,
          released: status === 'CLOSED' || status === 'SUBMITTED',
        });
      }
      const sessions = await seedSessions(seeds);
      const closedSessions = sessions.filter(
        (_id, index) => statuses[index] === 'CLOSED',
      );
      await seedClosings(closedSessions, cashierB.userId);

      // Unconditional grants take the DB path; an always-matching tenant
      // condition forces the per-row CASL path with the same visibility.
      const dbAudit: CashActor = {
        userId: cashierA.userId,
        ability: abilityOf([
          ['read', 'CashSession'],
          ['read', 'CashClosing'],
          ['read', 'CashSessionAudit'],
        ]),
      };
      const rowAudit: CashActor = {
        userId: cashierA.userId,
        ability: abilityOf([
          ['read', 'CashSession'],
          ['read', 'CashClosing'],
          ['read', 'CashSessionAudit', { tenantId: BASELINE_TENANT_ID }],
        ]),
      };
      const dbOwn: CashActor = {
        userId: cashierA.userId,
        ability: abilityOf([
          ['read', 'CashSession'],
          ['read', 'CashClosing'],
        ]),
      };
      const rowOwn: CashActor = {
        userId: cashierA.userId,
        ability: abilityOf([
          ['read', 'CashSession', { tenantId: BASELINE_TENANT_ID }],
          ['read', 'CashClosing', { tenantId: BASELINE_TENANT_ID }],
        ]),
      };
      const app = application(BASELINE_TENANT_ID);
      const sessionFilters: Array<
        Omit<Extract<CashQuery, { kind: 'SESSIONS' }>, 'kind' | 'page'> & {
          page?: Record<string, unknown>;
        }
      > = [
        {},
        { statuses: ['CLOSED'] },
        { drawerOpen: false },
        { pendingOnly: true },
        { page: { cashierUserId: cashierB.userId } },
        { page: { from: '2026-11-01T10:02:00Z', to: '2026-11-01T10:06:00Z' } },
      ];
      const pairs: Array<[CashActor, CashActor]> = [
        [dbAudit, rowAudit],
        [dbOwn, rowOwn],
      ];

      for (const [fast, slow] of pairs) {
        for (const filter of sessionFilters) {
          for (const page of [1, 2, 3]) {
            const query: CashQuery = {
              ...filter,
              kind: 'SESSIONS',
              page: { ...(filter.page ?? {}), page, limit: 2 },
            };
            expect(await app.query(fast, query)).toEqual(
              await app.query(slow, query),
            );
          }
        }
        for (const pageInput of [
          {},
          { cashierUserId: cashierA.userId },
          { from: '2026-11-02T10:01:00Z' },
        ]) {
          for (const page of [1, 2, 3]) {
            const query: CashQuery = {
              kind: 'CLOSINGS',
              page: { ...pageInput, page, limit: 1 },
            };
            expect(await app.query(fast, query)).toEqual(
              await app.query(slow, query),
            );
          }
        }
      }

      const firstPage = await app.query(dbAudit, {
        kind: 'SESSIONS',
        page: { page: 1, limit: 2 },
      });
      expect(firstPage.total).toBe(7);
      expect(ids(firstPage)).toEqual([sessions[6], sessions[5]]);
      const ownClosings = await app.query(dbOwn, {
        kind: 'CLOSINGS',
        page: { page: 1, limit: 10 },
      });
      // cashierB closed every cut, so cashierA sees only cuts of their own
      // sessions (indices 0, 2, 4, 6 are A's and all CLOSED).
      expect(ownClosings.total).toBe(4);
    });
  });
});
