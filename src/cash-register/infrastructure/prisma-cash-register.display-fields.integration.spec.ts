/**
 * fe-design-pass T1 (S1, S2, S3) — additive display fields over real
 * PostgreSQL: session list/detail `openedAt`, `closedAt`,
 * `cashierDisplayName`; custody `senderDisplayName`, `sourceRegisterName`,
 * `notes`. Register names never resolve across tenants.
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
import type { CashActor, CashDocument } from '../cash-application.port';
import { PrismaCashRegisterApplication } from './prisma-cash-register';

const asObject = (value: unknown): Record<string, unknown> =>
  value as Record<string, unknown>;
const asList = (value: unknown): Record<string, unknown>[] =>
  value as Record<string, unknown>[];

describe('cash display fields (PostgreSQL)', () => {
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

  async function member(tenantId: string, name: string): Promise<CashActor> {
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@cash-display.invalid`,
        name,
        hashedPassword: 'not-a-password',
        isActive: true,
      },
    });
    const role = await prisma.role.create({
      data: { name: randomUUID(), tenantId },
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

  async function handedOverSession(app: PrismaCashRegisterApplication) {
    const cashier = await member(BASELINE_TENANT_ID, 'Ana Cajera');
    const recipient = await member(BASELINE_TENANT_ID, 'Luis Supervisor');
    const register = await app.execute(
      cashier,
      { kind: 'CREATE_REGISTER', name: 'Caja Mostrador 2' },
      randomUUID(),
    );
    const opened = await app.execute(
      cashier,
      {
        kind: 'OPEN_SESSION',
        registerId: register.id as string,
        openingCents: 0,
        openingConfirmed: true,
      },
      randomUUID(),
    );
    const sessionId = asObject(opened.session).id as string;
    await app.execute(
      cashier,
      {
        kind: 'CASH_IN',
        sessionId,
        amountCents: 100000,
        reason: 'Fondo de prueba',
      },
      randomUUID(),
    );
    await app.execute(
      cashier,
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    await app.execute(
      cashier,
      {
        kind: 'DECLARE',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 100000 }],
      },
      randomUUID(),
    );
    const handover = await app.execute(
      cashier,
      {
        kind: 'CREATE_HANDOVER',
        sessionId,
        handoverKind: 'WITHDRAWAL',
        recipientUserId: recipient.userId,
        declaredCents: 100000,
        notes: 'Entrego todo el efectivo',
      },
      randomUUID(),
    );
    return { cashier, recipient, register, sessionId, handover };
  }

  it('adds openedAt, closedAt and cashierDisplayName to session list and detail', async () => {
    const app = application(BASELINE_TENANT_ID);
    const { cashier, recipient, sessionId } = await handedOverSession(app);
    const row = await prisma.cashSession.findUniqueOrThrow({
      where: { id: sessionId },
    });

    const list: CashDocument = await app.query(recipient, {
      kind: 'SESSIONS',
      page: {},
    });
    const [item] = asList(list.items);
    expect(item).toMatchObject({
      id: sessionId,
      cashierUserId: cashier.userId,
      openedAt: row.openedAt.toISOString(),
      closedAt: null,
      cashierDisplayName: 'Ana Cajera',
    });

    const detail = await app.query(recipient, {
      kind: 'SESSION',
      id: sessionId,
    });
    expect(asObject(detail.session)).toMatchObject({
      id: sessionId,
      openedAt: row.openedAt.toISOString(),
      closedAt: null,
      cashierDisplayName: 'Ana Cajera',
    });
  });

  it('adds sender name, source register name and notes to a pending WITHDRAWAL', async () => {
    const app = application(BASELINE_TENANT_ID);
    const { cashier, recipient, handover } = await handedOverSession(app);

    const custody = await app.query(recipient, {
      kind: 'CUSTODY',
      page: { page: 1, limit: 10 },
    });

    const [item] = asList(asObject(custody.pendingHandovers).items);
    expect(item).toMatchObject({
      id: handover.id,
      kind: 'WITHDRAWAL',
      senderUserId: cashier.userId,
      senderDisplayName: 'Ana Cajera',
      sourceRegisterName: 'Caja Mostrador 2',
      notes: 'Entrego todo el efectivo',
    });
    expect(item).not.toHaveProperty('sourceRegisterId');
  });
});
