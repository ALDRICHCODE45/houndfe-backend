import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createMongoAbility } from '@casl/ability';
import type { ClsService } from 'nestjs-cls';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { PrismaSaleRepository } from '../../sales/infrastructure/prisma-sale.repository';
import { PrismaCashRegisterApplication } from './prisma-cash-register';
import type { CashActor, CashDocument } from '../cash-application.port';

// Never opt into the normal/shared integration database or load dotenv.
const optedIn = process.env.CASH_PROOF_DISPOSABLE === '1';
const proof = optedIn ? describe : describe.skip;
function disposableUrl(): string {
  const raw = process.env.CASH_PROOF_DATABASE_URL;
  if (!raw || raw !== process.env.DATABASE_URL)
    throw new Error('Explicit matching disposable URLs required');
  const url = new URL(raw);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/cash_closing_proof_test' ||
    url.username !== 'cash_proof' ||
    !url.port ||
    ['5432', '5433'].includes(url.port)
  ) {
    throw new Error('Refusing non-disposable cash proof target');
  }
  return raw;
}
function sessionId(result: CashDocument): string {
  const session = result.session;
  if (
    !session ||
    typeof session !== 'object' ||
    Array.isArray(session) ||
    typeof session.id !== 'string'
  ) {
    throw new Error('Missing session response');
  }
  return session.id;
}

proof('cash register disposable PostgreSQL proof', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: disposableUrl() } },
    });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  function harness(tenantId: string) {
    // Each concurrent operation owns a separate CLS-like store; the Prisma
    // client, extension and database transactions are real, not mocked.
    const store = new Map<string, unknown>([
      ['tenantId', tenantId],
      ['isSuperAdmin', false],
    ]);
    // SAFETY: TenantPrismaService uses only get/set; separate stores prevent cross-transaction leakage.
    const cls = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    } as unknown as ClsService<TenantClsStore>;
    // SAFETY: PrismaService extends PrismaClient; this test needs no Nest lifecycle hooks.
    const tenant = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls,
    );
    return {
      tenant,
      app: new PrismaCashRegisterApplication(tenant),
      sales: new PrismaSaleRepository(tenant),
    };
  }
  async function fixture() {
    const tenant = await prisma.tenant.create({
      data: { name: 'Cash proof', slug: randomUUID() },
    });
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@cash-proof.invalid`,
        name: 'Proof cashier',
        hashedPassword: 'not-a-password',
        isActive: true,
      },
    });
    const role = await prisma.role.create({
      data: { name: randomUUID(), tenantId: tenant.id },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: tenant.id, userId: user.id, roleId: role.id },
    });
    const actor: CashActor = {
      userId: user.id,
      ability: createMongoAbility<AppAbility>([
        { action: 'manage', subject: 'all' },
      ]),
    };
    const first = harness(tenant.id);
    const register = await first.app.execute(
      actor,
      { kind: 'CREATE_REGISTER', name: randomUUID() },
      randomUUID(),
    );
    if (typeof register.id !== 'string') throw new Error('Missing register ID');
    const command = {
      kind: 'OPEN_SESSION' as const,
      registerId: register.id,
      openingCents: 0,
      openingConfirmed: true,
    };
    return {
      tenantId: tenant.id,
      actor,
      first,
      second: harness(tenant.id),
      command,
    };
  }

  it('enforces one unreleased drawer under concurrent opens and rejects cross-tenant register references', async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      f.first.app.execute(f.actor, f.command, randomUUID()),
      f.second.app.execute(f.actor, f.command, randomUUID()),
    ]);
    expect(
      outcomes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await prisma.cashSession.count({ where: { tenantId: f.tenantId } }),
    ).toBe(1);
    await expect(
      prisma.cashSession.create({
        data: {
          tenantId: f.tenantId,
          registerId: f.command.registerId,
          cashierUserId: f.actor.userId,
          openingCents: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const foreign = await prisma.tenant.create({
      data: { name: 'Foreign proof', slug: randomUUID() },
    });
    await expect(
      prisma.cashSession.create({
        data: {
          tenantId: foreign.id,
          registerId: f.command.registerId,
          cashierUserId: f.actor.userId,
          openingCents: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(
      await prisma.cashSession.count({ where: { tenantId: foreign.id } }),
    ).toBe(0);
  });

  it('rolls back payment, ledger and idempotency together and safely replays a committed ambient acquisition', async () => {
    const f = await fixture();
    const id = sessionId(
      await f.first.app.execute(f.actor, f.command, randomUUID()),
    );
    const sale = await prisma.sale.create({
      data: {
        tenantId: f.tenantId,
        userId: f.actor.userId,
        status: 'CONFIRMED',
        channel: 'POS',
      },
    });
    const key = randomUUID();
    await expect(
      f.first.tenant.runInTransaction(async () => {
        const slot = await f.first.sales.acquireChargeIdempotency(
          sale.id,
          key,
          'proof-hash',
        );
        expect(slot.kind).toBe('acquired');
        const payment = await f.first.tenant.getClient().salePayment.create({
          data: {
            tenantId: f.tenantId,
            saleId: sale.id,
            method: 'CASH',
            amountCents: 50000,
          },
        });
        await f.first.app.recordPayments({
          sessionId: id,
          actorId: f.actor.userId,
          saleId: sale.id,
          payments: [
            { paymentId: payment.id, method: 'cash', amountCents: 50000 },
          ],
          changeDueCents: 15000,
          occurredAt: new Date(),
        });
        throw new Error('proof rollback');
      }),
    ).rejects.toThrow('proof rollback');
    expect(
      await prisma.salePayment.count({
        where: { tenantId: f.tenantId, saleId: sale.id },
      }),
    ).toBe(0);
    expect(
      await prisma.cashMovement.count({
        where: { tenantId: f.tenantId, sessionId: id },
      }),
    ).toBe(0);
    expect(
      await prisma.saleIdempotency.count({
        where: { tenantId: f.tenantId, key },
      }),
    ).toBe(0);
    await f.first.tenant.runInTransaction(async () => {
      const slot = await f.first.sales.acquireChargeIdempotency(
        sale.id,
        key,
        'proof-hash',
      );
      if (slot.kind !== 'acquired')
        throw new Error('Expected fresh slot after rollback');
      await f.first.sales.markChargeIdempotencySucceeded(slot.token, sale.id, {
        proof: true,
      });
    });
    expect(
      await f.second.tenant.runInTransaction(() =>
        f.second.sales.acquireChargeIdempotency(sale.id, key, 'proof-hash'),
      ),
    ).toEqual({ kind: 'replay', payload: { proof: true } });
  });

  it('makes freeze wait for an in-flight ledger transaction and rejects later direct ledger writes', async () => {
    const f = await fixture();
    const id = sessionId(
      await f.first.app.execute(f.actor, f.command, randomUUID()),
    );
    let release!: () => void;
    let locked!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockGate = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const write = f.first.tenant.runInTransaction(async () => {
      await f.first.app.assertOpenSession(id, f.actor.userId);
      locked();
      await releaseGate;
      await f.first.app.recordPayments({
        sessionId: id,
        actorId: f.actor.userId,
        saleId: randomUUID(),
        payments: [
          { paymentId: randomUUID(), method: 'cash', amountCents: 50000 },
        ],
        changeDueCents: 15000,
        occurredAt: new Date(),
      });
    });
    await lockGate;
    const freeze = f.second.app.execute(
      f.actor,
      { kind: 'START_COUNT', sessionId: id },
      randomUUID(),
    );
    const results = Promise.allSettled([write, freeze]);
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const rows = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%cash_sessions%' AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked
        `;
        blocked = rows[0].blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
    } finally {
      release();
    }
    expect((await results).map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    const row = await prisma.cashSession.findUniqueOrThrow({ where: { id } });
    expect(row.expectedJson).toMatchObject({ cashExpectedCents: 35000 });
    const count = await prisma.cashMovement.count({
      where: { tenantId: f.tenantId },
    });
    await expect(
      f.second.tenant.runInTransaction(() =>
        f.second.app.recordRefund({
          sessionId: id,
          actorId: f.actor.userId,
          settlementId: randomUUID(),
          amountCents: 100,
          method: 'cash',
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_WRITABLE' });
    expect(
      await prisma.cashMovement.count({ where: { tenantId: f.tenantId } }),
    ).toBe(count);
    const original = await prisma.cashMovement.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    await expect(
      prisma.cashMovement.create({ data: { ...original, id: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(
      await prisma.cashMovement.count({ where: { tenantId: f.tenantId } }),
    ).toBe(count);
  });
});
