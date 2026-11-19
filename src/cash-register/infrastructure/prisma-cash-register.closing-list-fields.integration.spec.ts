/**
 * cash-redesign-reads T2 (S7) over real PostgreSQL:
 *   - GET /cash-closings items carry `register`, `cashier` and the frozen
 *     `differenceCents` for audit and own-only readers, on the DB-paged and
 *     the per-row path, with a CONSTANT number of SQL statements per page
 *     (no per-row reads);
 *   - a closing made by CLOSE freezes the session `openedAt`;
 *   - a snapshot frozen before T2 (no `openedAt`) still reads, as `null`.
 */
import { randomUUID } from 'node:crypto';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { Prisma, PrismaClient } from '@prisma/client';
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
import type { CashActor, CashDocument } from '../cash-application.port';
import { PrismaCashRegisterApplication } from './prisma-cash-register';

type ConditionalGrant = [AppActions, AppSubjects, Record<string, unknown>?];

const asList = (value: unknown): Record<string, unknown>[] =>
  value as Record<string, unknown>[];
const asObject = (value: unknown): Record<string, unknown> =>
  value as Record<string, unknown>;

describe('cash closing list fields and snapshot openedAt (PostgreSQL)', () => {
  let prisma: PrismaClient;
  // A second client on the SAME test database whose query log counts the SQL
  // statements one list read issues.
  let counting: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
  const statements: string[] = [];

  beforeAll(async () => {
    prisma = integrationPrisma();
    await prisma.$connect();
    counting = new PrismaClient<Prisma.PrismaClientOptions, 'query'>({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: [{ emit: 'event', level: 'query' }],
    });
    counting.$on('query', (event: Prisma.QueryEvent) => {
      statements.push(event.query);
    });
    await counting.$connect();
  });

  beforeEach(async () => {
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await counting.$disconnect();
    await resetAndSeedBaseline();
    await disconnectIntegrationPrisma();
  });

  function application(
    client: PrismaClient | PrismaClient<Prisma.PrismaClientOptions, 'query'>,
  ): PrismaCashRegisterApplication {
    const store = new Map<string, unknown>([
      ['tenantId', BASELINE_TENANT_ID],
      ['isSuperAdmin', false],
    ]);
    // SAFETY: TenantPrismaService uses only get/set on the CLS store.
    const cls = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    } as unknown as ClsService<TenantClsStore>;
    // SAFETY: PrismaService extends PrismaClient; no Nest lifecycle needed.
    const tenant = new TenantPrismaService(
      client as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
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

  async function member(
    name: string,
    grants: readonly ConditionalGrant[] = [['manage', 'all']],
  ): Promise<CashActor> {
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@cash-closings.invalid`,
        name,
        hashedPassword: 'not-a-password',
      },
    });
    const role = await prisma.role.create({
      data: { name: `role-${randomUUID()}`, tenantId: BASELINE_TENANT_ID },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: BASELINE_TENANT_ID, userId, roleId: role.id },
    });
    return { userId, ability: abilityOf(grants) };
  }

  interface Seeded {
    closingId: string;
    registerId: string;
    registerName: string;
    cashierUserId: string;
  }

  /** CLOSED sessions, each on its own register, with a closing row. */
  async function seedClosings(
    rows: ReadonlyArray<{
      cashier: string;
      closer: string;
      snapshot: Prisma.InputJsonValue;
    }>,
  ): Promise<Seeded[]> {
    const base = Date.parse('2026-11-01T10:00:00.000Z');
    const seeded: Seeded[] = [];
    for (const [index, row] of rows.entries()) {
      const registerName = `Caja ${index}`;
      const register = await prisma.cashRegister.create({
        data: { tenantId: BASELINE_TENANT_ID, name: registerName },
      });
      const openedAt = new Date(base + index * 60_000);
      const session = await prisma.cashSession.create({
        data: {
          tenantId: BASELINE_TENANT_ID,
          registerId: register.id,
          cashierUserId: row.cashier,
          openingCents: 0,
          status: 'CLOSED',
          openedAt,
          drawerReleasedAt: new Date(openedAt.getTime() + 1000),
          closedAt: new Date(openedAt.getTime() + 2000),
        },
      });
      const closing = await prisma.cashClosing.create({
        data: {
          tenantId: BASELINE_TENANT_ID,
          sessionId: session.id,
          folio: `F-${index}-${randomUUID()}`,
          closedByUserId: row.closer,
          snapshotJson: row.snapshot,
          createdAt: new Date(openedAt.getTime() + 3000),
        },
      });
      seeded.push({
        closingId: closing.id,
        registerId: register.id,
        registerName,
        cashierUserId: row.cashier,
      });
    }
    return seeded;
  }

  async function countedList(
    actor: CashActor,
    limit: number,
  ): Promise<{ doc: CashDocument; statementCount: number }> {
    statements.length = 0;
    const doc = await application(counting).query(actor, {
      kind: 'CLOSINGS',
      page: { page: 1, limit },
    });
    return { doc, statementCount: statements.length };
  }

  it('adds register, cashier and difference for audit and own-only readers with a constant statement count', async () => {
    const cashierA = await member('Ana Cajera');
    const cashierB = await member('Beto Cajero');
    const closer = await member('Luis Supervisor');
    const seeded = await seedClosings([
      {
        cashier: cashierA.userId,
        closer: closer.userId,
        snapshot: { comparison: { declarationDifferenceCents: -500 } },
      },
      {
        cashier: cashierB.userId,
        closer: closer.userId,
        snapshot: { declaredCents: 1200, expectedCents: 1000 },
      },
      {
        cashier: cashierA.userId,
        closer: closer.userId,
        snapshot: {},
      },
      {
        cashier: cashierA.userId,
        closer: closer.userId,
        snapshot: { comparison: { declarationDifferenceCents: 0 } },
      },
    ]);
    const expected = (index: number, differenceCents: number | null) => ({
      id: seeded[index].closingId,
      register: {
        id: seeded[index].registerId,
        name: seeded[index].registerName,
      },
      cashier: {
        userId: seeded[index].cashierUserId,
        displayName: index === 1 ? 'Beto Cajero' : 'Ana Cajera',
      },
      differenceCents,
    });

    const readers: Array<[string, CashActor, unknown[]]> = [
      [
        'audit (DB path)',
        {
          userId: closer.userId,
          ability: abilityOf([
            ['read', 'CashClosing'],
            ['read', 'CashSessionAudit'],
          ]),
        },
        [
          expected(3, 0),
          expected(2, null),
          expected(1, 200),
          expected(0, -500),
        ],
      ],
      [
        'audit (per-row path)',
        {
          userId: closer.userId,
          ability: abilityOf([
            ['read', 'CashClosing'],
            ['read', 'CashSessionAudit', { tenantId: BASELINE_TENANT_ID }],
          ]),
        },
        [
          expected(3, 0),
          expected(2, null),
          expected(1, 200),
          expected(0, -500),
        ],
      ],
      [
        'own-only (DB path)',
        {
          userId: cashierA.userId,
          ability: abilityOf([['read', 'CashClosing']]),
        },
        [expected(3, 0), expected(2, null), expected(0, -500)],
      ],
      [
        'own-only (per-row path)',
        {
          userId: cashierA.userId,
          ability: abilityOf([
            ['read', 'CashClosing', { tenantId: BASELINE_TENANT_ID }],
          ]),
        },
        [expected(3, 0), expected(2, null), expected(0, -500)],
      ],
    ];

    for (const [label, reader, items] of readers) {
      const one = await countedList(reader, 1);
      const all = await countedList(reader, 10);

      expect({ label, items: asList(all.doc.items) }).toEqual({
        label,
        items: items.map((item): unknown => expect.objectContaining(item)),
      });
      expect({ label, items: asList(one.doc.items) }).toEqual({
        label,
        items: [expect.objectContaining(items[0])],
      });
      // No N+1: a page of 1 and a page of 3-4 issue the same statements.
      expect(one.statementCount).toBeGreaterThan(0);
      expect({ label, count: all.statementCount }).toEqual({
        label,
        count: one.statementCount,
      });
    }
  });

  it('freezes the session openedAt in a new closing snapshot', async () => {
    const cashier = await member('Ana Cajera');
    const closer = await member('Luis Supervisor');
    const register = await prisma.cashRegister.create({
      data: { tenantId: BASELINE_TENANT_ID, name: 'Caja Mostrador' },
    });
    const openedAt = new Date('2026-11-05T14:00:00.000Z');
    const session = await prisma.cashSession.create({
      data: {
        tenantId: BASELINE_TENANT_ID,
        registerId: register.id,
        cashierUserId: cashier.userId,
        openingCents: 0,
        status: 'SUBMITTED',
        openedAt,
        frozenAt: new Date('2026-11-05T20:00:00.000Z'),
        submittedAt: new Date('2026-11-05T20:05:00.000Z'),
        drawerReleasedAt: new Date('2026-11-05T20:10:00.000Z'),
        expectedJson: {
          cashExpectedCents: 1000,
          frozenAt: '2026-11-05T20:00:00.000Z',
          channels: [
            {
              channelKey: 'CASH',
              channelLabel: 'Efectivo',
              method: 'CASH',
              expectedCents: 1000,
            },
          ],
        },
      },
    });
    for (const [kind, actorUserId] of [
      ['DECLARATION', cashier.userId],
      ['VERIFICATION', closer.userId],
    ] as const) {
      await prisma.cashCount.create({
        data: {
          tenantId: BASELINE_TENANT_ID,
          sessionId: session.id,
          kind,
          revision: 1,
          actorUserId,
          linesJson: [{ channelKey: 'CASH', amountCents: 1000 }],
        },
      });
    }
    await prisma.cashHandover.create({
      data: {
        tenantId: BASELINE_TENANT_ID,
        sourceSessionId: session.id,
        kind: 'FLOAT',
        recipientUserId: cashier.userId,
        createdByUserId: cashier.userId,
        declaredCents: 1000,
        receivedCents: 1000,
        receivedAt: new Date('2026-11-05T20:08:00.000Z'),
        receivedByUserId: cashier.userId,
      },
    });
    const app = application(prisma);

    const closed = await app.execute(
      closer,
      { kind: 'CLOSE', sessionId: session.id },
      `close-${randomUUID()}`,
    );
    const read = await app.query(closer, {
      kind: 'CLOSING',
      id: closed.id as string,
    });

    expect(asObject(closed.snapshot).openedAt).toBe(openedAt.toISOString());
    expect(asObject(read.snapshot).openedAt).toBe(openedAt.toISOString());
  });

  it('still reads an old snapshot without openedAt, exposing it as null', async () => {
    const cashier = await member('Ana Cajera');
    const closer = await member('Luis Supervisor');
    const oldSnapshot = {
      folio: 'legacy',
      closedAt: '2026-10-01T20:00:00.000Z',
      comparison: { declarationDifferenceCents: 300 },
    };
    const [seeded] = await seedClosings([
      { cashier: cashier.userId, closer: closer.userId, snapshot: oldSnapshot },
    ]);
    const app = application(prisma);

    const read = await app.query(closer, {
      kind: 'CLOSING',
      id: seeded.closingId,
    });
    const list = await app.query(closer, {
      kind: 'CLOSINGS',
      page: {},
    });

    expect(read.snapshot).toEqual({ ...oldSnapshot, openedAt: null });
    expect(asList(list.items)[0]).toMatchObject({
      id: seeded.closingId,
      differenceCents: 300,
    });
    // The stored row is untouched: the null is a read-time projection.
    const row = await prisma.cashClosing.findUniqueOrThrow({
      where: { id: seeded.closingId },
    });
    expect(row.snapshotJson).toEqual(oldSnapshot);
  });
});
