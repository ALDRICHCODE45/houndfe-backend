/**
 * human-intervention / unit 2, slice 2b — staff commands against real
 * PostgreSQL: concurrent claims, claim vs cancel, idempotent replay, the
 * customer-group row, R4 (claim/release never touch human_decisions), tenant
 * boundaries and 20 parallel commands on one customer group (no deadlock).
 *
 * Each command runs in its own nestjs-cls ALS context and its own interactive
 * transaction on one shared pool, like concurrent HTTP requests.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { integrationPrisma } from '../../test/integration/reset-db';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import {
  ChatbotRequestCommandError,
  ChatbotRequestCommandsService,
  type StaffCommand,
  type StaffCommandInput,
} from './application/chatbot-request-commands.service';
import {
  allocateFolio,
  assertTenantLinks,
  refreshCustomerGroup,
} from './infrastructure/chatbot-request-writes';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb('chatbot request staff commands (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    cls,
  );
  const service = new ChatbotRequestCommandsService(
    new PrismaChatbotRequestCommandStore(tenantPrisma),
  );
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const users = {
    ana: randomUUID(),
    luis: randomUUID(),
    eva: randomUUID(),
    upd: randomUUID(),
  };
  let customerSeq = 0;

  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'test', isSuperAdmin: false }, work);

  const run = (
    tenantId: string,
    requestId: string,
    actorUserId: string,
    command: StaffCommand,
    over: Partial<StaffCommandInput> = {},
  ) =>
    inTenant(tenantId, () =>
      service.execute({
        requestId,
        actorUserId,
        actorCanReassign: false,
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
        command,
        ...over,
      }),
    );

  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'OK',
      (error: unknown) => {
        if (error instanceof ChatbotRequestCommandError) return error.code;
        throw error;
      },
    );

  /** Creates an open request the way intake will: folio + group in one tx. */
  async function createRequest(
    tenantId: string,
    over: Record<string, unknown> = {},
  ) {
    const customerKey =
      (over.customerKey as string) ?? `52550000${++customerSeq}`;
    return inTenant(tenantId, () =>
      tenantPrisma.runInTransaction(async () => {
        const tx = tenantPrisma.getClient();
        const row = await tx.chatbotRequest.create({
          data: {
            tenantId,
            folio: await allocateFolio(tx, tenantId),
            kind: 'CLARIFICATION',
            subtype: 'UNKNOWN_QUESTION',
            customerKey,
            summary: '¿Sirve para cachorros?',
            source: 'chatbot',
            sourceRequestId: randomUUID(),
            ...over,
          },
        });
        await refreshCustomerGroup(tx, tenantId, customerKey);
        return row;
      }),
    );
  }

  const group = (tenantId: string, customerKey: string) =>
    prisma.chatbotCustomerGroup.findUnique({
      where: { tenantId_customerKey: { tenantId, customerKey } },
      select: { openCount: true, mostUrgentAt: true, hasOverdue: true },
    });
  const events = (requestId: string) =>
    prisma.chatbotRequestEvent.findMany({
      where: { requestId },
      orderBy: { version: 'asc' },
    });

  beforeAll(async () => {
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.create({
        data: { id, name: 'Solicitudes', slug: `cr-commands-${id}` },
      });
    }
    for (const [name, id] of Object.entries(users)) {
      await prisma.user.create({
        data: {
          id,
          email: `${id}@cr.test`,
          hashedPassword: 'x',
          name,
        },
      });
    }
    const grant = (action: string) =>
      prisma.permission.upsert({
        where: { subject_action: { subject: 'ChatbotRequest', action } },
        update: {},
        create: { subject: 'ChatbotRequest', action },
      });
    const [read, update] = [await grant('read'), await grant('update')];
    const role = await prisma.role.create({
      data: {
        tenantId: tenantA,
        name: `Atiende ${tenantA}`,
        permissions: {
          create: [{ permissionId: read.id }, { permissionId: update.id }],
        },
      },
    });
    const updateOnly = await prisma.role.create({
      data: {
        tenantId: tenantA,
        name: `Solo actualiza ${tenantA}`,
        permissions: { create: { permissionId: update.id } },
      },
    });
    const bare = await prisma.role.create({
      data: { tenantId: tenantA, name: `Sin permiso ${tenantA}` },
    });
    await prisma.tenantMembership.createMany({
      data: [
        { userId: users.ana, tenantId: tenantA, roleId: role.id },
        { userId: users.luis, tenantId: tenantA, roleId: role.id },
        { userId: users.eva, tenantId: tenantA, roleId: bare.id },
        { userId: users.upd, tenantId: tenantA, roleId: updateOnly.id },
      ],
    });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
  });

  it('two concurrent claims: exactly one wins', async () => {
    const request = await createRequest(tenantA);

    const results = await Promise.all([
      outcome(run(tenantA, request.id, users.ana, { kind: 'claim' })),
      outcome(run(tenantA, request.id, users.luis, { kind: 'claim' })),
    ]);

    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(['REQUEST_CLAIMED_BY_OTHER', 'VERSION_CONFLICT']).toContain(
      results.find((r) => r !== 'OK'),
    );
    const stored = await prisma.chatbotRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(stored).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    expect(await events(request.id)).toHaveLength(1);
    expect(await group(tenantA, request.customerKey)).toMatchObject({
      openCount: 1,
    });
  });

  it('concurrent claim and cancel: one wins and the group follows it', async () => {
    for (let round = 0; round < 5; round++) {
      const request = await createRequest(tenantA);
      const [claimed, cancelled] = await Promise.all([
        outcome(run(tenantA, request.id, users.ana, { kind: 'claim' })),
        outcome(
          run(tenantA, request.id, users.luis, {
            kind: 'cancel',
            reason: 'DUPLICATE',
          }),
        ),
      ]);

      expect([claimed, cancelled].filter((r) => r === 'OK')).toHaveLength(1);
      const stored = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(stored.version).toBe(2);
      expect(await events(request.id)).toHaveLength(1);
      if (claimed === 'OK') {
        expect(cancelled).toBe('NOT_ASSIGNEE');
        expect(await group(tenantA, request.customerKey)).toMatchObject({
          openCount: 1,
        });
      } else {
        expect(['VERSION_CONFLICT', 'REQUEST_CLOSED']).toContain(claimed);
        expect(stored.status).toBe('CANCELLED');
        expect(await group(tenantA, request.customerKey)).toBeNull();
      }
    }
  });

  it('replays the same key and body with one event and one receipt', async () => {
    const request = await createRequest(tenantA);
    const key = randomUUID();
    const over = { idempotencyKey: key };

    const [first, second] = await Promise.all([
      run(tenantA, request.id, users.ana, { kind: 'claim' }, over),
      run(tenantA, request.id, users.ana, { kind: 'claim' }, over),
    ]);
    // Released afterwards: the replay still answers the stored response.
    await run(
      tenantA,
      request.id,
      users.ana,
      { kind: 'release' },
      {
        expectedVersion: 2,
      },
    );
    const third = await run(
      tenantA,
      request.id,
      users.ana,
      { kind: 'claim' },
      over,
    );

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect((await events(request.id)).map((e) => e.type)).toEqual([
      'CLAIMED',
      'RELEASED',
    ]);
    expect(
      await prisma.staffCommandReceipt.count({
        where: { tenantId: tenantA, actorId: users.ana, idempotencyKey: key },
      }),
    ).toBe(1);
    await expect(
      outcome(
        run(
          tenantA,
          request.id,
          users.ana,
          { kind: 'claim' },
          {
            ...over,
            expectedVersion: 3,
          },
        ),
      ),
    ).resolves.toBe('IDEMPOTENCY_CONFLICT');
  });

  it('keeps the customer group consistent after each command', async () => {
    const customerKey = '525511112222';
    const at = (iso: string) => new Date(iso);
    const first = await createRequest(tenantA, {
      customerKey,
      claimDeadlineAt: at('2026-11-10T17:00:00Z'),
      resolveDeadlineAt: at('2026-11-10T19:00:00Z'),
    });
    const second = await createRequest(tenantA, {
      customerKey,
      claimDeadlineAt: at('2026-11-10T18:00:00Z'),
      resolveDeadlineAt: at('2026-11-10T20:00:00Z'),
      overdueAt: at('2026-11-10T18:00:00Z'),
    });
    expect(await group(tenantA, customerKey)).toEqual({
      openCount: 2,
      mostUrgentAt: at('2026-11-10T17:00:00Z'),
      hasOverdue: true,
    });

    // Claiming moves the first request to its resolve deadline.
    await run(tenantA, first.id, users.ana, { kind: 'claim' });
    expect(await group(tenantA, customerKey)).toEqual({
      openCount: 2,
      mostUrgentAt: at('2026-11-10T18:00:00Z'),
      hasOverdue: true,
    });

    await run(tenantA, second.id, users.ana, {
      kind: 'cancel',
      reason: 'NOT_ACTIONABLE',
    });
    expect(await group(tenantA, customerKey)).toEqual({
      openCount: 1,
      mostUrgentAt: at('2026-11-10T19:00:00Z'),
      hasOverdue: false,
    });

    await run(
      tenantA,
      first.id,
      users.ana,
      { kind: 'release' },
      {
        expectedVersion: 2,
      },
    );
    expect(await group(tenantA, customerKey)).toMatchObject({
      mostUrgentAt: at('2026-11-10T17:00:00Z'),
    });
    await run(
      tenantA,
      first.id,
      users.ana,
      {
        kind: 'cancel',
        reason: 'DUPLICATE',
      },
      { expectedVersion: 3 },
    );
    expect(await group(tenantA, customerKey)).toBeNull();
  });

  it('R4: claim and release never touch the wrapped human_decisions row', async () => {
    const decision = await prisma.humanDecision.create({
      data: {
        tenantId: tenantA,
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        canonicalRequestHash: 'hash',
        submittedCredentialId: 'cred',
        branchId: tenantA,
        productId: randomUUID(),
        productName: 'Croquetas',
      },
    });
    const request = await createRequest(tenantA, {
      kind: 'DECISION',
      subtype: 'RESTOCK',
      humanDecisionId: decision.id,
    });

    await run(tenantA, request.id, users.ana, { kind: 'claim' });
    await run(
      tenantA,
      request.id,
      users.ana,
      { kind: 'release' },
      {
        expectedVersion: 2,
      },
    );
    await expect(
      outcome(
        run(
          tenantA,
          request.id,
          users.ana,
          { kind: 'resolve', action: 'X' },
          {
            expectedVersion: 3,
          },
        ),
      ),
    ).resolves.toBe('ACTION_NOT_ALLOWED');

    expect(
      await prisma.humanDecision.findUniqueOrThrow({
        where: { id: decision.id },
      }),
    ).toEqual(decision);
    expect(
      await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: request.id },
      }),
    ).toMatchObject({ status: 'NEW', version: 3 });
  });

  it('rejects a request id or a linked id from another tenant as NOT_FOUND', async () => {
    const foreign = await createRequest(tenantB);

    await expect(
      outcome(run(tenantA, foreign.id, users.ana, { kind: 'claim' })),
    ).resolves.toBe('NOT_FOUND');
    expect(
      await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: foreign.id },
      }),
    ).toMatchObject({ status: 'NEW', version: 1 });

    const customer = await prisma.customer.create({
      data: { tenantId: tenantB, firstName: 'Juan' },
    });
    const check = (tenantId: string) =>
      inTenant(tenantId, () =>
        assertTenantLinks(tenantPrisma.getClient(), tenantId, {
          customerId: customer.id,
        }),
      );
    await expect(outcome(check(tenantA))).resolves.toBe('NOT_FOUND');
    await expect(check(tenantB)).resolves.toBeUndefined();
  });

  it('reassigns only to an active member with read and update:ChatbotRequest (an update-only user is not assignable)', async () => {
    const request = await createRequest(tenantA);
    await run(tenantA, request.id, users.ana, { kind: 'claim' });

    for (const toUserId of [users.eva, users.upd, randomUUID()]) {
      await expect(
        outcome(
          run(
            tenantA,
            request.id,
            users.ana,
            { kind: 'reassign', toUserId },
            {
              expectedVersion: 2,
              actorCanReassign: true,
            },
          ),
        ),
      ).resolves.toBe('USER_NOT_ASSIGNABLE');
    }
    const view = await run(
      tenantA,
      request.id,
      users.ana,
      { kind: 'reassign', toUserId: users.luis },
      { expectedVersion: 2, actorCanReassign: true },
    );
    expect(view.assignee).toEqual({ id: users.luis, displayName: 'luis' });
  });

  it('uses its own advisory-lock namespace, apart from the cash (hashtext, hashtext) keys', async () => {
    const request = await createRequest(tenantA);
    const key = randomUUID();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // A cash-style key that equals what a shared namespace would use.
    const cashStyle = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantA}), hashtext(${`${users.ana}:${key}`}))::text`;
      locked();
      await held;
    });
    await lockTaken;
    try {
      const outcomeOrTimeout = await Promise.race([
        run(
          tenantA,
          request.id,
          users.ana,
          { kind: 'claim' },
          {
            idempotencyKey: key,
          },
        ).then(() => 'DONE'),
        new Promise<string>((resolve) => setTimeout(resolve, 3000, 'BLOCKED')),
      ]);
      expect(outcomeOrTimeout).toBe('DONE');
    } finally {
      release();
      await cashStyle;
    }
  });

  it('refuses to run above READ COMMITTED (the group refresh relies on it)', async () => {
    const request = await createRequest(tenantA);

    await expect(
      inTenant(tenantA, () =>
        tenantPrisma.runInTransaction(
          () =>
            service.execute({
              requestId: request.id,
              actorUserId: users.ana,
              actorCanReassign: false,
              idempotencyKey: randomUUID(),
              expectedVersion: 1,
              command: { kind: 'claim' },
            }),
          'RepeatableRead',
        ),
      ),
    ).rejects.toThrow(/READ COMMITTED/);
    expect(
      await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: request.id },
      }),
    ).toMatchObject({ status: 'NEW', version: 1 });
    await expect(
      run(tenantA, request.id, users.ana, { kind: 'claim' }),
    ).resolves.toMatchObject({ status: 'IN_PROGRESS' });
  });

  it('20 parallel commands on one customer group finish without deadlock', async () => {
    const customerKey = '525533334444';
    const requests: { id: string }[] = [];
    for (let i = 0; i < 20; i++) {
      requests.push(await createRequest(tenantA, { customerKey }));
    }

    const claims = await Promise.all(
      requests.map((r) =>
        outcome(run(tenantA, r.id, users.ana, { kind: 'claim' })),
      ),
    );
    expect(claims).toEqual(Array(20).fill('OK'));
    expect(await group(tenantA, customerKey)).toMatchObject({ openCount: 20 });

    const cancels = await Promise.all(
      requests.map((r) =>
        outcome(
          run(
            tenantA,
            r.id,
            users.ana,
            { kind: 'cancel', reason: 'DUPLICATE' },
            {
              expectedVersion: 2,
            },
          ),
        ),
      ),
    );
    expect(cancels).toEqual(Array(20).fill('OK'));
    expect(await group(tenantA, customerKey)).toBeNull();
    expect(
      await prisma.chatbotRequestEvent.count({
        where: { requestId: { in: requests.map((r) => r.id) } },
      }),
    ).toBe(40);
  });

  it('allocates unique consecutive folios under concurrency', async () => {
    const tenantId = tenantB;
    const folios = await Promise.all(
      Array.from({ length: 10 }, () =>
        inTenant(tenantId, () =>
          tenantPrisma.runInTransaction(() =>
            allocateFolio(tenantPrisma.getClient(), tenantId),
          ),
        ),
      ),
    );
    const sorted = [...folios].sort((a, b) => a - b);
    expect(new Set(folios).size).toBe(10);
    expect(sorted[9] - sorted[0]).toBe(9);
  });
});
