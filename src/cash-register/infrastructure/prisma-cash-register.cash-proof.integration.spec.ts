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

  async function member(tenantId: string, userId: string = randomUUID()) {
    await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        email: `${userId}@cash-proof.invalid`,
        name: 'Discovery recipient',
        hashedPassword: 'not-a-password',
        isActive: true,
      },
      update: {},
    });
    const role = await prisma.role.create({
      data: { name: randomUUID(), tenantId },
    });
    await prisma.tenantMembership.create({
      data: { tenantId, userId, roleId: role.id },
    });
    return userId;
  }

  function object(value: unknown): CashDocument {
    expect(value).not.toBeNull();
    expect(typeof value).toBe('object');
    expect(Array.isArray(value)).toBe(false);
    return value as CashDocument;
  }

  function custodyActor(userId: string): CashActor {
    return {
      userId,
      ability: createMongoAbility<AppAbility>([
        { action: 'read', subject: 'CashHandover' },
        { action: 'update', subject: 'CashHandover' },
        { action: 'create', subject: 'CashSession' },
        { action: 'read', subject: 'CashSession' },
      ]),
    };
  }

  it('discovers frozen cash and transfer identities through a fresh client without exposing blind amounts', async () => {
    const f = await fixture();
    const id = sessionId(
      await f.first.app.execute(f.actor, f.command, randomUUID()),
    );
    const reader: CashActor = {
      userId: f.actor.userId,
      ability: createMongoAbility<AppAbility>([
        { action: 'read', subject: 'CashSession' },
      ]),
    };
    expect(
      await f.first.app.query(reader, { kind: 'SESSION', id }),
    ).not.toHaveProperty('requiredChannels');
    await f.first.tenant.runInTransaction(() =>
      f.first.app.recordPayments({
        sessionId: id,
        actorId: f.actor.userId,
        saleId: randomUUID(),
        payments: [
          { paymentId: randomUUID(), method: 'cash', amountCents: 1000 },
          { paymentId: randomUUID(), method: 'transfer', amountCents: 250 },
        ],
        changeDueCents: 0,
        occurredAt: new Date(),
      }),
    );
    await f.first.app.execute(
      f.actor,
      { kind: 'START_COUNT', sessionId: id },
      randomUUID(),
    );
    const detail = await f.second.app.query(reader, { kind: 'SESSION', id });
    expect(object(detail.session)).toMatchObject({ blind: true });
    expect(object(detail.session)).not.toHaveProperty('expectedCashCents');
    expect(detail.channelSnapshot).toBeNull();
    expect(detail.movements).toEqual([]);
    expect(detail.requiredChannels).toEqual([
      { channelKey: 'CASH', channelLabel: 'Efectivo', method: 'CASH' },
      {
        channelKey: 'METHOD:TRANSFER',
        channelLabel: 'Transferencia',
        method: 'TRANSFER',
      },
    ]);
    expect(await f.first.app.query(reader, { kind: 'SESSION', id })).toEqual(
      detail,
    );
    const foreign = await fixture();
    await member(foreign.tenantId, reader.userId);
    await expect(
      foreign.first.app.query(reader, { kind: 'SESSION', id }),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_FOUND' });
    await f.first.app.execute(
      f.actor,
      {
        kind: 'DECLARE',
        sessionId: id,
        lines: [
          { channelKey: 'CASH', amountCents: 1000 },
          { channelKey: 'METHOD:TRANSFER', amountCents: 250 },
        ],
      },
      randomUUID(),
    );
    const submitted = await f.second.app.query(reader, { kind: 'SESSION', id });
    expect(submitted).not.toHaveProperty('requiredChannels');
    expect(object(submitted.session).blind).toBe(false);
    expect(submitted.channelSnapshot).not.toBeNull();
  });

  it('scopes custody to authorized tenant recipients and consumes a received FLOAT only once', async () => {
    const f = await fixture();
    const recipient = custodyActor(await member(f.tenantId));
    const other = custodyActor(await member(f.tenantId));
    const id = sessionId(
      await f.first.app.execute(f.actor, f.command, randomUUID()),
    );
    await f.first.app.execute(
      f.actor,
      {
        kind: 'CASH_IN',
        sessionId: id,
        amountCents: 1000,
        reason: 'Fictional proof',
      },
      randomUUID(),
    );
    await f.first.app.execute(
      f.actor,
      { kind: 'START_COUNT', sessionId: id },
      randomUUID(),
    );
    await f.first.app.execute(
      f.actor,
      {
        kind: 'DECLARE',
        sessionId: id,
        lines: [{ channelKey: 'CASH', amountCents: 1000 }],
      },
      randomUUID(),
    );
    const handover = await f.first.app.execute(
      f.actor,
      {
        kind: 'CREATE_HANDOVER',
        sessionId: id,
        handoverKind: 'FLOAT',
        recipientUserId: recipient.userId,
        declaredCents: 1000,
      },
      randomUUID(),
    );
    expect(typeof handover.id).toBe('string');
    const handoverId = handover.id as string;
    const query = { kind: 'CUSTODY' as const, page: { page: 1, limit: 10 } };
    const empty = {
      pendingHandovers: { items: [], page: 1, limit: 10, total: 0 },
      eligibleFloat: { items: [], page: 1, limit: 10, total: 0 },
    };
    const pending = await f.second.app.query(recipient, query);
    expect(object(pending.pendingHandovers)).toMatchObject({
      total: 1,
      page: 1,
      limit: 10,
    });
    expect(object(pending.pendingHandovers).items).toEqual([
      {
        id: handoverId,
        sessionId: id,
        kind: 'FLOAT',
        declaredCents: 1000,
        receivedCents: null,
        senderUserId: f.actor.userId,
        receiverUserId: recipient.userId,
        declaredAt: handover.declaredAt,
        receivedAt: null,
        sourceRegisterId: f.command.registerId,
        sourceDrawerReleasedAt: null,
      },
    ]);
    expect(object(pending.eligibleFloat)).toEqual(empty.eligibleFloat);
    expect(await f.second.app.query(other, query)).toEqual(empty);
    const foreign = await fixture();
    await member(foreign.tenantId, recipient.userId);
    expect(await foreign.first.app.query(recipient, query)).toEqual(empty);
    for (const rules of [
      [],
      [{ action: 'read' as const, subject: 'CashSessionAudit' as const }],
    ]) {
      await expect(
        f.second.app.query(
          {
            userId: recipient.userId,
            ability: createMongoAbility<AppAbility>(rules),
          },
          query,
        ),
      ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
    }
    const conditional: CashActor = {
      userId: recipient.userId,
      ability: createMongoAbility<AppAbility>([
        {
          action: 'read',
          subject: 'CashHandover',
          conditions: { kind: 'WITHDRAWAL' },
        },
      ]),
    };
    expect(await f.second.app.query(conditional, query)).toEqual(empty);
    await expect(
      f.second.app.execute(
        other,
        { kind: 'RECEIVE_HANDOVER', id: handoverId, receivedCents: 1000 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_HANDOVER_RECIPIENT_INVALID' });
    expect(await f.second.app.query(recipient, query)).toEqual(pending);
    const receipt = await f.second.app.execute(
      recipient,
      { kind: 'RECEIVE_HANDOVER', id: handoverId, receivedCents: 1000 },
      randomUUID(),
    );
    const received = await f.second.app.query(recipient, query);
    expect(object(received.pendingHandovers)).toEqual(empty.pendingHandovers);
    expect(object(received.eligibleFloat)).toMatchObject({ total: 1 });
    expect(object(received.eligibleFloat).items).toEqual([
      {
        ...object((object(pending.pendingHandovers).items as unknown[])[0]),
        receivedCents: 1000,
        receivedAt: receipt.receivedAt,
      },
    ]);
    const opening = {
      ...f.command,
      openingCents: 1000,
      openingHandoverId: handoverId,
    };
    await expect(
      f.second.app.execute(recipient, opening, randomUUID()),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_UNRELEASED_SESSION' });
    expect(await f.second.app.query(recipient, query)).toEqual(received);
    const newRegister = await f.first.app.execute(
      f.actor,
      { kind: 'CREATE_REGISTER', name: randomUUID() },
      randomUUID(),
    );
    const opened = await f.second.app.execute(
      recipient,
      { ...opening, registerId: newRegister.id as string },
      randomUUID(),
    );
    expect(sessionId(opened)).toEqual(expect.any(String));
    expect(await f.second.app.query(recipient, query)).toEqual(empty);
    const thirdRegister = await f.first.app.execute(
      f.actor,
      { kind: 'CREATE_REGISTER', name: randomUUID() },
      randomUUID(),
    );
    const beforeRejected = await f.second.app.query(recipient, {
      kind: 'SESSIONS',
      page: {},
    });
    await expect(
      f.second.app.execute(
        recipient,
        { ...opening, registerId: thirdRegister.id as string },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_OPENING_FLOAT_REUSE' });
    expect(
      await f.second.app.query(recipient, { kind: 'SESSIONS', page: {} }),
    ).toEqual(beforeRejected);
    expect(await f.second.app.query(recipient, query)).toEqual(empty);
  });

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
