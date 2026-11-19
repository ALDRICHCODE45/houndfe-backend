/**
 * pdf-a4-redesign T6 (S4) over real PostgreSQL: new closings get a per-tenant
 * consecutive folio (CC-000124) from an atomically incremented counter.
 *   - concurrent closings in ONE tenant (separate connections/transactions)
 *     get distinct, consecutive folios — never the same number;
 *   - another tenant starts at CC-000001 on its own sequence;
 *   - closings stored before the counter keep their folio untouched.
 */
import { randomUUID } from 'node:crypto';
import { createMongoAbility } from '@casl/ability';
import type { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  integrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type { CashActor } from '../cash-application.port';
import { PrismaCashRegisterApplication } from './prisma-cash-register';

const OTHER_TENANT_ID = '00000000-0000-0000-0000-0000000000c3';
const CONCURRENT_CLOSINGS = 8;

describe('cash closing folio sequence (PostgreSQL)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = integrationPrisma();
    await prisma.$connect();
  });

  beforeEach(async () => {
    await resetAndSeedBaseline();
    await prisma.tenant.create({
      data: { id: OTHER_TENANT_ID, name: 'Otra', slug: 'otra-sucursal-folio' },
    });
  });

  afterAll(async () => {
    await resetAndSeedBaseline();
    await disconnectIntegrationPrisma();
  });

  /** One application per call: its own CLS store, same real database. */
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

  async function member(tenantId: string, name: string): Promise<CashActor> {
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@closing-folio.invalid`,
        name,
        hashedPassword: 'not-a-password',
      },
    });
    const role = await prisma.role.create({
      data: { name: `role-${randomUUID()}`, tenantId },
    });
    await prisma.tenantMembership.create({
      data: { tenantId, userId, roleId: role.id },
    });
    return {
      userId,
      ability: createMongoAbility<AppAbility>([
        { action: 'manage', subject: 'all' },
      ]),
    };
  }

  /** A SUBMITTED session ready to close (verified, drawer released). */
  async function readySession(
    tenantId: string,
    cashier: CashActor,
    closer: CashActor,
    label: string,
  ): Promise<string> {
    const register = await prisma.cashRegister.create({
      data: { tenantId, name: `Caja ${label}-${randomUUID()}` },
    });
    const openedAt = new Date('2026-11-05T14:00:00.000Z');
    const session = await prisma.cashSession.create({
      data: {
        tenantId,
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
          tenantId,
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
        tenantId,
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
    return session.id;
  }

  async function closeSession(
    tenantId: string,
    closer: CashActor,
    sessionId: string,
  ): Promise<string> {
    const closed = await application(tenantId).execute(
      closer,
      { kind: 'CLOSE', sessionId },
      `close-${randomUUID()}`,
    );
    return closed.folio as string;
  }

  const sequence = (folio: string): number => Number(folio.slice('CC-'.length));

  it('gives concurrent closings in one tenant distinct consecutive folios and starts another tenant at CC-000001', async () => {
    const cashier = await member(BASELINE_TENANT_ID, 'Ana Cajera');
    const closer = await member(BASELINE_TENANT_ID, 'Luis Supervisor');
    const otherCashier = await member(OTHER_TENANT_ID, 'Otra Cajera');
    const otherCloser = await member(OTHER_TENANT_ID, 'Otro Supervisor');
    const sessions: string[] = [];
    for (let index = 0; index < CONCURRENT_CLOSINGS; index += 1) {
      sessions.push(
        await readySession(BASELINE_TENANT_ID, cashier, closer, `a${index}`),
      );
    }
    const otherSession = await readySession(
      OTHER_TENANT_ID,
      otherCashier,
      otherCloser,
      'b',
    );

    // All closings are in flight at once, each on its own transaction.
    const [otherFolio, ...folios] = await Promise.all([
      closeSession(OTHER_TENANT_ID, otherCloser, otherSession),
      ...sessions.map((sessionId) =>
        closeSession(BASELINE_TENANT_ID, closer, sessionId),
      ),
    ]);

    expect(new Set(folios).size).toBe(CONCURRENT_CLOSINGS);
    expect(folios.map(sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: CONCURRENT_CLOSINGS }, (_, index) => index + 1),
    );
    for (const folio of folios) {
      expect(folio).toMatch(/^CC-\d{6}$/);
    }
    expect(otherFolio).toBe('CC-000001');

    // What is stored matches what was returned, and the counters agree.
    const stored = await prisma.cashClosing.findMany({
      where: { tenantId: BASELINE_TENANT_ID },
      select: { folio: true },
    });
    expect(stored.map((row) => row.folio).sort()).toEqual([...folios].sort());
    const counters = await prisma.cashClosingFolioCounter.findMany();
    expect(
      Object.fromEntries(counters.map((c) => [c.tenantId, c.lastNumber])),
    ).toEqual({
      [BASELINE_TENANT_ID]: CONCURRENT_CLOSINGS,
      [OTHER_TENANT_ID]: 1,
    });
  }, 60_000);

  it('keeps a stored legacy UUID folio untouched and continues the sequence for new closings', async () => {
    const cashier = await member(BASELINE_TENANT_ID, 'Ana Cajera');
    const closer = await member(BASELINE_TENANT_ID, 'Luis Supervisor');
    const legacySession = await readySession(
      BASELINE_TENANT_ID,
      cashier,
      closer,
      'legacy',
    );
    const legacyFolio = `CC-${randomUUID()}`;
    await prisma.cashSession.update({
      where: { id: legacySession },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    const legacy = await prisma.cashClosing.create({
      data: {
        tenantId: BASELINE_TENANT_ID,
        sessionId: legacySession,
        folio: legacyFolio,
        closedByUserId: closer.userId,
        snapshotJson: { folio: legacyFolio },
      },
    });
    const first = await readySession(BASELINE_TENANT_ID, cashier, closer, 'n1');
    const second = await readySession(
      BASELINE_TENANT_ID,
      cashier,
      closer,
      'n2',
    );

    expect(await closeSession(BASELINE_TENANT_ID, closer, first)).toBe(
      'CC-000001',
    );
    expect(await closeSession(BASELINE_TENANT_ID, closer, second)).toBe(
      'CC-000002',
    );

    const row = await prisma.cashClosing.findUniqueOrThrow({
      where: { id: legacy.id },
    });
    expect(row.folio).toBe(legacyFolio);
    expect(row.snapshotJson).toEqual({ folio: legacyFolio });
  }, 60_000);

  it('grows past 999999 without truncating the folio', async () => {
    const cashier = await member(BASELINE_TENANT_ID, 'Ana Cajera');
    const closer = await member(BASELINE_TENANT_ID, 'Luis Supervisor');
    await prisma.cashClosingFolioCounter.create({
      data: { tenantId: BASELINE_TENANT_ID, lastNumber: 999999 },
    });
    const session = await readySession(
      BASELINE_TENANT_ID,
      cashier,
      closer,
      'big',
    );

    expect(await closeSession(BASELINE_TENANT_ID, closer, session)).toBe(
      'CC-1000000',
    );
  }, 30_000);
});
