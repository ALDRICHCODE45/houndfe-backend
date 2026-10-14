/**
 * PrismaSaleRepository — ambient-transaction idempotency acquire (T4/T6 S5,S8).
 *
 * The repository's pre-existing acquire is
 * `create → catch P2002 → findUnique`. That sequence is only safe against an
 * autocommit connection. Inside a PostgreSQL transaction a unique violation
 * ABORTS the whole transaction (25P02), so even a NORMAL retry against an
 * already-committed slot poisons the ambient transaction and the follow-up
 * replay read fails. The cash-register closing bound SalesService wrappers
 * (S5/S8) put the acquire INSIDE one ambient transaction precisely so a
 * rejected session fence or a session-bound credit tender rolls the freshly
 * acquired row back with the money writes.
 *
 * These tests model the abort-on-duplicate rule with a fake transaction
 * client, then prove the conflict-safe ambient acquire
 * (`createMany({ skipDuplicates: true })`, i.e. INSERT ... ON CONFLICT DO
 * NOTHING) keeps the four externally consumed outcomes intact WITHOUT ever
 * raising, for the charge, payment and settlement PUBLIC repository methods.
 *
 * DB GAP — a Jest fake cannot reproduce PostgreSQL MVCC or row locking. It
 * only encodes the abort-on-duplicate rule the real driver enforces. Real
 * concurrency/race proof still requires an explicitly isolated PostgreSQL
 * database; nothing here replaces it.
 */
import { randomUUID } from 'crypto';
import { PrismaSaleRepository } from './prisma-sale.repository';

type IdempotencyStatus = 'IN_FLIGHT' | 'SUCCEEDED';

interface IdempotencyRow {
  id: string;
  tenantId: string;
  operation: string;
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseJson: unknown;
  saleId: string | null;
  updatedAt: Date;
}

interface IdempotencyCreateData {
  id?: string;
  tenantId: string;
  operation: string;
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseJson?: unknown;
  saleId: string | null;
}

interface IdempotencyWhere {
  id?: string;
  tenantId?: string;
  operation?: string;
  key?: string;
  requestHash?: string;
  status?: string;
  updatedAt?: { lt?: Date };
}

interface IdempotencyKeyWhere {
  tenantId_operation_key: { tenantId: string; operation: string; key: string };
}

interface IdempotencyDelegate {
  create: jest.Mock;
  createMany: jest.Mock;
  findUnique: jest.Mock;
  updateMany: jest.Mock;
  deleteMany: jest.Mock;
}

interface AmbientTxClient {
  saleIdempotency: IdempotencyDelegate;
}

interface AmbientTxHarness {
  repo: PrismaSaleRepository;
  client: AmbientTxClient;
  delegate: IdempotencyDelegate;
  setInTransaction: (value: boolean) => void;
  isAborted: () => boolean;
  rows: () => IdempotencyRow[];
}

const TENANT = 'tenant-1';

const keyOf = (row: {
  tenantId: string;
  operation: string;
  key: string;
}): string => `${row.tenantId}\u0000${row.operation}\u0000${row.key}`;

const reject = (error: unknown): Promise<never> =>
  Promise.reject(error instanceof Error ? error : new Error(String(error)));

const uniqueViolation = (): Error => {
  const error = new Error(
    'Unique constraint failed on the fields: (`tenantId`,`operation`,`key`)',
  );
  (error as { code?: string }).code = 'P2002';
  return error;
};

const abortedTransaction = (): Error => {
  const error = new Error(
    'current transaction is aborted, commands ignored until end of transaction block',
  );
  (error as { code?: string }).code = '25P02';
  return error;
};

const matchesWhere = (
  row: IdempotencyRow,
  where: IdempotencyWhere,
): boolean => {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.tenantId !== undefined && row.tenantId !== where.tenantId)
    return false;
  if (where.operation !== undefined && row.operation !== where.operation)
    return false;
  if (where.key !== undefined && row.key !== where.key) return false;
  if (where.requestHash !== undefined && row.requestHash !== where.requestHash)
    return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (
    where.updatedAt?.lt !== undefined &&
    !(row.updatedAt < where.updatedAt.lt)
  )
    return false;
  return true;
};

function makeAmbientTxHarness(
  seedRows: Partial<IdempotencyRow>[] = [],
): AmbientTxHarness {
  const store: IdempotencyRow[] = seedRows.map((row) => ({
    id: randomUUID(),
    tenantId: TENANT,
    operation: 'sale_charge',
    key: 'key-1',
    requestHash: 'hash-1',
    status: 'IN_FLIGHT',
    responseJson: null,
    saleId: null,
    updatedAt: new Date(),
    ...row,
  }));
  let aborted = false;

  const dead = (): Error | null => (aborted ? abortedTransaction() : null);

  const createImpl = (args: {
    data: IdempotencyCreateData;
  }): Promise<IdempotencyRow> => {
    const poisoned = dead();
    if (poisoned) return reject(poisoned);
    if (store.some((row) => keyOf(row) === keyOf(args.data))) {
      aborted = true;
      return reject(uniqueViolation());
    }
    const row: IdempotencyRow = {
      ...args.data,
      id: args.data.id ?? randomUUID(),
      responseJson: args.data.responseJson ?? null,
      updatedAt: new Date(),
    };
    store.push(row);
    return Promise.resolve(row);
  };

  const createManyImpl = (args: {
    data: IdempotencyCreateData[];
    skipDuplicates?: boolean;
  }): Promise<{ count: number }> => {
    const poisoned = dead();
    if (poisoned) return reject(poisoned);
    let count = 0;
    for (const item of args.data) {
      if (store.some((row) => keyOf(row) === keyOf(item))) {
        if (args.skipDuplicates) continue;
        aborted = true;
        return reject(uniqueViolation());
      }
      store.push({
        ...item,
        id: item.id ?? randomUUID(),
        responseJson: item.responseJson ?? null,
        updatedAt: new Date(),
      });
      count += 1;
    }
    return Promise.resolve({ count });
  };

  const findUniqueImpl = (args: {
    where: IdempotencyKeyWhere;
  }): Promise<IdempotencyRow | null> => {
    const poisoned = dead();
    if (poisoned) return reject(poisoned);
    const { tenantId, operation, key } = args.where.tenantId_operation_key;
    const found =
      store.find(
        (row) =>
          row.tenantId === tenantId &&
          row.operation === operation &&
          row.key === key,
      ) ?? null;
    return Promise.resolve(found);
  };

  const updateManyImpl = (args: {
    where: IdempotencyWhere;
    data: Partial<IdempotencyRow>;
  }): Promise<{ count: number }> => {
    const poisoned = dead();
    if (poisoned) return reject(poisoned);
    let count = 0;
    for (const row of store) {
      if (matchesWhere(row, args.where)) {
        Object.assign(row, args.data, { updatedAt: new Date() });
        count += 1;
      }
    }
    return Promise.resolve({ count });
  };

  const deleteManyImpl = (args: {
    where: IdempotencyWhere;
  }): Promise<{ count: number }> => {
    const poisoned = dead();
    if (poisoned) return reject(poisoned);
    let count = 0;
    for (let index = store.length - 1; index >= 0; index -= 1) {
      if (matchesWhere(store[index], args.where)) {
        store.splice(index, 1);
        count += 1;
      }
    }
    return Promise.resolve({ count });
  };

  const delegate: IdempotencyDelegate = {
    create: jest.fn(createImpl),
    createMany: jest.fn(createManyImpl),
    findUnique: jest.fn(findUniqueImpl),
    updateMany: jest.fn(updateManyImpl),
    deleteMany: jest.fn(deleteManyImpl),
  };
  const client: AmbientTxClient = { saleIdempotency: delegate };

  const isInTransaction = jest.fn().mockReturnValue(true);
  const tenantPrisma = {
    getClient: jest.fn().mockReturnValue(client),
    getTenantId: jest.fn().mockReturnValue(TENANT),
    isInTransaction,
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
  };

  return {
    repo: new PrismaSaleRepository(tenantPrisma as never),
    client,
    delegate,
    setInTransaction: (value: boolean) =>
      isInTransaction.mockReturnValue(value),
    isAborted: () => aborted,
    rows: () => store,
  };
}

interface PublicAcquire {
  label: string;
  operation: string;
  key: string;
  invoke: (repo: PrismaSaleRepository) => Promise<unknown>;
}

const publicAcquires: PublicAcquire[] = [
  {
    label: 'charge',
    operation: 'sale_charge',
    key: 'key-1',
    invoke: (repo) =>
      repo.acquireChargeIdempotency('sale-1', 'key-1', 'hash-1'),
  },
  {
    label: 'payment',
    operation: 'sale_payment',
    key: 'key-1',
    invoke: (repo) =>
      repo.acquirePaymentIdempotency('sale-1', 'key-1', 'hash-1'),
  },
  {
    label: 'settlement',
    operation: 'sale_refund_settlement',
    key: 'refund:settle:refund-1:key-1',
    invoke: (repo) =>
      repo.acquireSettlementIdempotency('refund-1', 'key-1', 'hash-1'),
  },
];

describe('PrismaSaleRepository — ambient transaction idempotency acquire', () => {
  it('models PostgreSQL abort semantics: a duplicate create poisons the transaction', async () => {
    const harness = makeAmbientTxHarness([
      {
        requestHash: 'hash-1',
        status: 'SUCCEEDED',
        responseJson: { ok: true },
      },
    ]);

    await expect(
      harness.delegate.create({
        data: {
          tenantId: TENANT,
          operation: 'sale_charge',
          key: 'key-1',
          requestHash: 'hash-1',
          status: 'IN_FLIGHT',
          saleId: 'sale-1',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(harness.isAborted()).toBe(true);

    await expect(
      harness.delegate.findUnique({
        where: {
          tenantId_operation_key: {
            tenantId: TENANT,
            operation: 'sale_charge',
            key: 'key-1',
          },
        },
      }),
    ).rejects.toMatchObject({ code: '25P02' });
  });

  it.each(publicAcquires)(
    'fresh $label acquire inserts an explicitly generated slot without the aborting create',
    async ({ operation, key, invoke }) => {
      const harness = makeAmbientTxHarness();

      const outcome = (await invoke(harness.repo)) as {
        kind: string;
        token: string;
      };

      expect(outcome.kind).toBe('acquired');
      expect(outcome.token).toEqual(expect.any(String));
      expect(harness.delegate.create).not.toHaveBeenCalled();
      expect(harness.isAborted()).toBe(false);
      expect(harness.delegate.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            id: outcome.token,
            tenantId: TENANT,
            operation,
            key,
            requestHash: 'hash-1',
            status: 'IN_FLIGHT',
          }),
        ],
        skipDuplicates: true,
      });
    },
  );

  it.each(publicAcquires)(
    'replays a committed $label slot without raising (the normal retry)',
    async ({ operation, key, invoke }) => {
      const harness = makeAmbientTxHarness([
        {
          operation,
          key,
          requestHash: 'hash-1',
          status: 'SUCCEEDED',
          responseJson: { saleId: 'sale-1' },
        },
      ]);

      await expect(invoke(harness.repo)).resolves.toEqual({
        kind: 'replay',
        payload: { saleId: 'sale-1' },
      });
      expect(harness.delegate.create).not.toHaveBeenCalled();
      expect(harness.isAborted()).toBe(false);
      expect(harness.delegate.createMany).toHaveBeenCalledTimes(1);
    },
  );

  it.each(publicAcquires)(
    'returns conflict for a $label slot with a different request hash',
    async ({ operation, key, invoke }) => {
      const harness = makeAmbientTxHarness([
        {
          operation,
          key,
          requestHash: 'hash-OLD',
          status: 'SUCCEEDED',
          responseJson: {},
        },
      ]);

      await expect(invoke(harness.repo)).resolves.toEqual({ kind: 'conflict' });
      expect(harness.delegate.create).not.toHaveBeenCalled();
      expect(harness.isAborted()).toBe(false);
    },
  );

  it.each(publicAcquires)(
    'returns in_flight for a live $label slot with the same request hash',
    async ({ operation, key, invoke }) => {
      const harness = makeAmbientTxHarness([
        {
          operation,
          key,
          requestHash: 'hash-1',
          status: 'IN_FLIGHT',
          updatedAt: new Date(),
        },
      ]);

      await expect(invoke(harness.repo)).resolves.toEqual({
        kind: 'in_flight',
      });
      expect(harness.delegate.create).not.toHaveBeenCalled();
      expect(harness.isAborted()).toBe(false);
    },
  );

  it('reclaims an expired settlement slot after the lease and re-acquires safely', async () => {
    const staleAt = new Date(Date.now() - 10 * 60 * 1000);
    const harness = makeAmbientTxHarness([
      {
        operation: 'sale_refund_settlement',
        key: 'refund:settle:refund-1:key-1',
        requestHash: 'hash-1',
        status: 'IN_FLIGHT',
        updatedAt: staleAt,
      },
    ]);

    const outcome = (await harness.repo.acquireSettlementIdempotency(
      'refund-1',
      'key-1',
      'hash-1',
    )) as { kind: string; token: string };

    expect(outcome.kind).toBe('acquired');
    const expectedReclaimWhere: Record<string, unknown> = {
      tenantId: TENANT,
      operation: 'sale_refund_settlement',
      key: 'refund:settle:refund-1:key-1',
      requestHash: 'hash-1',
      status: 'IN_FLIGHT',
      updatedAt: { lt: expect.any(Date) as unknown },
    };
    expect(harness.delegate.deleteMany).toHaveBeenCalledWith({
      where: expectedReclaimWhere,
    });
    expect(harness.delegate.createMany).toHaveBeenCalledTimes(2);
    expect(harness.delegate.create).not.toHaveBeenCalled();
    expect(harness.isAborted()).toBe(false);
  });

  it('does not reclaim a live settlement slot', async () => {
    const harness = makeAmbientTxHarness([
      {
        operation: 'sale_refund_settlement',
        key: 'refund:settle:refund-1:key-1',
        requestHash: 'hash-1',
        status: 'IN_FLIGHT',
        updatedAt: new Date(),
      },
    ]);

    await expect(
      harness.repo.acquireSettlementIdempotency('refund-1', 'key-1', 'hash-1'),
    ).resolves.toEqual({ kind: 'in_flight' });
    expect(harness.delegate.deleteMany).toHaveBeenCalledTimes(1);
    expect(harness.rows()).toHaveLength(1);
  });

  it('propagates a non-duplicate failure from the conflict-safe insert', async () => {
    const harness = makeAmbientTxHarness();
    const failure = new Error('connection reset by peer');
    (failure as { code?: string }).code = 'P1001';
    harness.delegate.createMany.mockRejectedValueOnce(failure);

    await expect(
      harness.repo.acquireChargeIdempotency('sale-1', 'key-1', 'hash-1'),
    ).rejects.toBe(failure);
  });

  it('throws IDEMPOTENCY_STATE_NOT_FOUND when the conflict-safe insert skipped but no row is readable', async () => {
    const harness = makeAmbientTxHarness();
    // Model a row that became invisible/removed between the conflict-safe
    // INSERT and the follow-up read.
    harness.delegate.createMany.mockResolvedValueOnce({ count: 0 });
    harness.delegate.findUnique.mockResolvedValueOnce(null);

    await expect(
      harness.repo.acquireChargeIdempotency('sale-1', 'key-1', 'hash-1'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_STATE_NOT_FOUND' });
  });

  it('keeps the untouched legacy create path outside an ambient transaction', async () => {
    const harness = makeAmbientTxHarness();
    harness.setInTransaction(false);

    const outcome = (await harness.repo.acquireChargeIdempotency(
      'sale-1',
      'key-1',
      'hash-1',
    )) as { kind: string; token: string };

    expect(outcome.kind).toBe('acquired');
    expect(harness.delegate.create).toHaveBeenCalledTimes(1);
    expect(harness.delegate.createMany).not.toHaveBeenCalled();
  });

  it('keeps replay, conflict and in-flight semantics on the legacy branch', async () => {
    const states: Array<[Partial<IdempotencyRow>, unknown]> = [
      [
        { requestHash: 'hash-1', status: 'SUCCEEDED', responseJson: { ok: 1 } },
        { kind: 'replay', payload: { ok: 1 } },
      ],
      [{ requestHash: 'other', status: 'SUCCEEDED' }, { kind: 'conflict' }],
      [{ requestHash: 'hash-1', status: 'IN_FLIGHT' }, { kind: 'in_flight' }],
    ];

    for (const [row, expected] of states) {
      const isolated = makeAmbientTxHarness([row]);
      isolated.setInTransaction(false);
      isolated.delegate.create.mockRejectedValue(uniqueViolation());
      await expect(
        isolated.repo.acquireChargeIdempotency('sale-1', 'key-1', 'hash-1'),
      ).resolves.toEqual(expected);
    }
  });
});
