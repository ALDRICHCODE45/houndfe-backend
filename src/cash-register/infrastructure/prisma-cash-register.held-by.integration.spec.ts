/**
 * cash-register-held-by over real PostgreSQL: `GET /cash-registers` reports
 * `drawerHeld` / `drawerHeldStatus` / `drawerHeldSince` for every caller and
 * `heldBy` (with the cashier name) only under the GET /cash-sessions
 * visibility rule, and `drawerHeld` agrees with the authoritative opening
 * guard (422 `CASH_REGISTER_UNRELEASED_SESSION`) — including a CLOSED
 * session whose drawer was never released.
 */
import { randomUUID } from 'node:crypto';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import type { PrismaClient } from '@prisma/client';
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
import type { CashActor } from '../cash-application.port';
import { PrismaCashRegisterApplication } from './prisma-cash-register';

type Grant = readonly [AppActions, AppSubjects];

const asObject = (value: unknown): Record<string, unknown> =>
  value as Record<string, unknown>;
const asList = (value: unknown): Record<string, unknown>[] =>
  value as Record<string, unknown>[];

const anyString: unknown = expect.any(String);

const CASHIER: readonly Grant[] = [
  ['read', 'CashRegister'],
  ['read', 'CashSession'],
  ['create', 'CashSession'],
];

describe('cash register drawer hold (PostgreSQL)', () => {
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

  async function member(
    name: string,
    grants?: readonly Grant[],
  ): Promise<CashActor> {
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@cash-held-by.invalid`,
        name,
        hashedPassword: 'not-a-password',
        isActive: true,
      },
    });
    const role = await prisma.role.create({
      data: { name: randomUUID(), tenantId: BASELINE_TENANT_ID },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: BASELINE_TENANT_ID, userId, roleId: role.id },
    });
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    if (grants) {
      for (const [action, subject] of grants) {
        can(action, subject);
      }
    } else {
      can('manage', 'all');
    }
    return { userId, ability: build() };
  }

  async function open(
    app: PrismaCashRegisterApplication,
    who: CashActor,
    registerId: string,
  ): Promise<string> {
    const doc = await app.execute(
      who,
      {
        kind: 'OPEN_SESSION',
        registerId,
        openingCents: 0,
        openingConfirmed: true,
      },
      randomUUID(),
    );
    return asObject(doc.session).id as string;
  }

  async function registers(
    app: PrismaCashRegisterApplication,
    who: CashActor,
  ): Promise<Record<string, Record<string, unknown>>> {
    const doc = await app.query(who, { kind: 'REGISTERS' });
    return Object.fromEntries(
      asList(doc.items).map((item) => [item.id as string, item]),
    );
  }

  it('matches the opening guard and gates heldBy by session visibility', async () => {
    const app = application(BASELINE_TENANT_ID);
    const admin = await member('Dueña');
    const ana = await member('Ana Cajera', CASHIER);
    const luis = await member('Luis Cajero', CASHIER);
    const create = async (name: string) =>
      (
        await app.execute(
          admin,
          { kind: 'CREATE_REGISTER', name },
          randomUUID(),
        )
      ).id as string;
    const free = await create('Caja Libre');
    const held = await create('Caja Ana');
    const heldClosed = await create('Caja Cerrada');
    const sessionId = await open(app, ana, held);
    const closedId = await open(app, ana, heldClosed);
    // A CLOSED session whose drawer was never released still blocks.
    await prisma.cashSession.update({
      where: { id: closedId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    const row = await prisma.cashSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const openedAt = row.openedAt.toISOString();

    const forLuis = await registers(app, luis);
    expect(forLuis[held]).toEqual({
      id: held,
      name: 'Caja Ana',
      isActive: true,
      createdAt: anyString,
      drawerHeld: true,
      drawerHeldStatus: 'OPEN',
      drawerHeldSince: openedAt,
      heldBy: null,
    });
    expect(JSON.stringify(forLuis)).not.toContain('Ana Cajera');
    expect(forLuis[heldClosed]).toMatchObject({
      drawerHeld: true,
      drawerHeldStatus: 'CLOSED',
      heldBy: null,
    });
    expect(forLuis[free]).toMatchObject({
      drawerHeld: false,
      drawerHeldStatus: null,
      drawerHeldSince: null,
      heldBy: null,
    });

    expect((await registers(app, ana))[held].heldBy).toEqual({
      sessionId,
      status: 'OPEN',
      openedAt,
      cashierDisplayName: 'Ana Cajera',
      byMe: true,
    });
    expect((await registers(app, admin))[held].heldBy).toMatchObject({
      sessionId,
      cashierDisplayName: 'Ana Cajera',
      byMe: false,
    });

    // Parity: every held register is exactly one the guard rejects.
    for (const registerId of [held, heldClosed]) {
      await expect(open(app, luis, registerId)).rejects.toMatchObject({
        code: 'CASH_REGISTER_UNRELEASED_SESSION',
      });
    }
    await expect(open(app, luis, free)).resolves.toEqual(expect.any(String));
    expect((await registers(app, luis))[free]).toMatchObject({
      drawerHeld: true,
      heldBy: { byMe: true, cashierDisplayName: 'Luis Cajero' },
    });
  });
});
