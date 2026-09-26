/**
 * HD-04b3 — PrismaHumanDecisionReviewReadRepository DB-free behavior spec.
 *
 * Mocks `TenantPrismaService` (`getClient` / `getTenantId`) so no PostgreSQL
 * roundtrip happens. These tests prove the adapter seams: explicit tenant +
 * source + type scoping on every query, hardcoded `PENDING` list status, the
 * stable `createdAt,id` ordering, safe `skip`/`take`, literal LIKE wildcard
 * escaping, the mapper-field SELECT allowlist, cross-tenant `null` detail, and
 * value-free argument errors.
 *
 * These mocked tests do NOT prove real PostgreSQL `ILIKE` wildcard behavior,
 * CLS ALS, or the tenant-scoping extension. HD-04b3b owns the dedicated-DB
 * integration proof against the isolated local RESTOCK database.
 */

import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  HumanDecisionReviewReadError,
  type HumanDecisionReviewListQuery,
  type HumanDecisionReviewRecord,
} from '../domain/human-decision-review-read.repository';
import { PrismaHumanDecisionReviewReadRepository } from './prisma-human-decision-review-read.repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DECISION_ID = '22222222-2222-4222-8222-222222222222';

const REVIEW_SELECT_KEYS = [
  'branchId',
  'branchName',
  'createdAt',
  'id',
  'observedStockAtRequest',
  'productId',
  'productName',
  'requestedQuantity',
  'resolutionAction',
  'resolvedAt',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'restockDays',
  'sku',
  'status',
  'stockObservedAt',
  'type',
  'variantId',
  'version',
];

const FORBIDDEN_SELECT_KEYS = [
  'tenantId',
  'source',
  'sourceRequestId',
  'canonicalRequestHash',
  'submittedCredentialId',
  'supersedesDecisionId',
  'resolutionRequestId',
  'resolvedById',
  'applicationOutcome',
  'applicationAttemptId',
  'applicationEvidenceHash',
  'applicationEvidenceCode',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'applicationAttemptedAt',
  'ackReceivedAt',
  'updatedAt',
];

interface CapturedFindManyArgs {
  where: Record<string, unknown>;
  orderBy: unknown;
  skip: number;
  take: number;
  select: Record<string, boolean>;
}

interface CapturedFindFirstArgs {
  where: Record<string, unknown>;
  select: Record<string, boolean>;
}

interface ClientMock {
  humanDecision: {
    findMany: jest.Mock;
    count: jest.Mock;
    findFirst: jest.Mock;
  };
}

function makeRecord(
  overrides: Partial<HumanDecisionReviewRecord> = {},
): HumanDecisionReviewRecord {
  return {
    id: DECISION_ID,
    type: RESTOCK_TYPE,
    status: 'PENDING',
    version: 1,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    branchId: TENANT_ID,
    branchName: 'Sucursal Centro',
    productId: '33333333-3333-4333-8333-333333333333',
    productName: 'Cafe de altura',
    variantId: '44444444-4444-4444-8444-444444444444',
    sku: 'SKU-1',
    requestedQuantity: 5,
    observedStockAtRequest: 0,
    stockObservedAt: new Date('2026-09-01T10:00:00.000Z'),
    resolutionAction: null,
    restockDays: null,
    resolvedAt: null,
    resolvedByActorId: null,
    resolvedByDisplayName: null,
    ...overrides,
  };
}

function makeClient(): ClientMock {
  return {
    humanDecision: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
  };
}

function makeRepo(
  client: ClientMock,
  options: { tenantId?: string | null; clock?: () => Date } = {},
) {
  const tenantId =
    options.tenantId === undefined ? TENANT_ID : options.tenantId;
  const tenantPrisma = {
    getClient: jest.fn(() => client),
    getTenantId: jest.fn(() => {
      if (!tenantId) {
        throw new Error('Tenant context required');
      }
      return tenantId;
    }),
  };
  const repo = new PrismaHumanDecisionReviewReadRepository(
    tenantPrisma as unknown as TenantPrismaService,
    options.clock,
  );
  return { repo, tenantPrisma };
}

describe('combined snapshot reads', () => {
  function harness(pendingCount: number, resolvedCount: number) {
    const tx = makeClient();
    const root = makeClient();
    root.humanDecision.count.mockImplementation(() => {
      throw new Error('root read');
    });
    root.humanDecision.findMany.mockImplementation(() => {
      throw new Error('root read');
    });
    tx.humanDecision.count
      .mockResolvedValueOnce(pendingCount)
      .mockResolvedValueOnce(resolvedCount);
    tx.humanDecision.findMany.mockImplementation((args: CapturedFindManyArgs) =>
      Promise.resolve(
        Array.from({ length: args.take }, (_, index) =>
          makeRecord({
            id: `${String(args.where.status)}-${args.skip + index}`,
            status: String(args.where.status),
          }),
        ),
      ),
    );
    const transaction = jest.fn(
      async (work: (client: ClientMock) => Promise<unknown>) => work(tx),
    );
    const client = Object.assign(root, { $transaction: transaction });
    const tenant = {
      getClient: jest.fn(() => client),
      getTenantId: jest.fn(() => TENANT_ID),
      isInTransaction: jest.fn(() => false),
    };
    const now = new Date('2026-09-30T12:00:00.000Z');
    const clock = jest.fn(() => now);
    const repo = new PrismaHumanDecisionReviewReadRepository(
      tenant as unknown as TenantPrismaService,
      clock,
    );
    return { repo, tx, root, tenant, transaction, clock, now };
  }

  describe.each([20, 50])('page size %i', (limit) => {
    it.each([
      ['empty', 0, 0, 1],
      ['all pending', 3, 0, 1],
      ['all resolved', 0, 3, 1],
      ['exact boundary', limit, limit, 2],
      ['cross boundary', limit + 3, limit * 3, 2],
      ['full subsequent page', limit + 3, limit * 3, 3],
      ['beyond end', 2, 2, 5],
    ] as const)('%s', async (_label, p, r, page) => {
      const h = harness(p, r);
      const result = await h.repo.listAll({ page, limit });
      const expected = [
        ...Array.from({ length: p }, (_, i) => `PENDING-${i}`),
        ...Array.from({ length: r }, (_, i) => `RESOLVED-${i}`),
      ].slice((page - 1) * limit, page * limit);
      expect(result.items.map(({ id }) => id)).toEqual(expected);
      expect(result).toMatchObject({
        pageIndex0: page - 1,
        pageSize: limit,
        totalCount: p + r,
        pageCount: Math.ceil((p + r) / limit),
      });
      expect(result.items.length).toBeLessThanOrEqual(limit);
      expect(h.transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'RepeatableRead',
      });
      expect(h.tenant.getClient).toHaveBeenCalledTimes(1);
      expect(h.clock).toHaveBeenCalledTimes(1);
      expect(h.root.humanDecision.count).not.toHaveBeenCalled();
      expect(h.root.humanDecision.findMany).not.toHaveBeenCalled();
    });
  });

  it('uses identical scoped predicates, one callback clock and fixed partition ordering', async () => {
    const h = harness(3, 30);
    h.clock.mockImplementation(() => {
      expect(h.transaction).toHaveBeenCalledTimes(1);
      return h.now;
    });
    await h.repo.listAll({ page: 1, limit: 20, search: 'Cafe%_\\' });
    const counts = h.tx.humanDecision.count.mock.calls as [
      { where: Record<string, unknown> },
    ][];
    for (const [index, status] of ['PENDING', 'RESOLVED'].entries()) {
      const args = findManyArgs(h.tx, index);
      expect(args.where).toBe(counts[index][0].where);
      expect(args.where).toEqual({
        tenantId: TENANT_ID,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
        status,
        productName: { contains: 'Cafe\\%\\_\\\\', mode: 'insensitive' },
        ...(status === 'RESOLVED'
          ? {
              resolvedAt: {
                gte: new Date(h.now.getTime() - 604800000),
                lte: h.now,
              },
            }
          : {}),
      });
      expect(args.orderBy).toEqual([
        index === 0 ? { createdAt: 'asc' } : { resolvedAt: 'desc' },
        { id: 'asc' },
      ]);
      expect(Object.keys(args.select).sort()).toEqual(REVIEW_SELECT_KEYS);
    }
  });

  it('keeps transaction reads when external state changes after counts (orchestration only)', async () => {
    const h = harness(3, 30);
    h.tx.humanDecision.count
      .mockReset()
      .mockResolvedValueOnce(3)
      .mockImplementationOnce(() => {
        h.root.humanDecision.findMany.mockResolvedValue([
          makeRecord({ id: 'external-change' }),
        ]);
        return Promise.resolve(30);
      });
    const result = await h.repo.listAll({ page: 1, limit: 20 });
    expect(result.totalCount).toBe(33);
    expect(result.items.slice(0, 3).map(({ id }) => id)).toEqual([
      'PENDING-0',
      'PENDING-1',
      'PENDING-2',
    ]);
    expect(h.root.humanDecision.findMany).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'RESOLVED'])(
    'rejects a wrong row in the %s partition',
    async (partition) => {
      const h = harness(partition === 'PENDING' ? 1 : 0, 1);
      h.tx.humanDecision.findMany.mockResolvedValue([
        makeRecord({
          status: partition === 'PENDING' ? 'RESOLVED' : 'PENDING',
        }),
      ]);
      await expect(h.repo.listAll({ page: 1, limit: 20 })).rejects.toThrow();
    },
  );

  it('rejects ambient transactions before getClient and fails closed without tenant', async () => {
    const h = harness(1, 1);
    h.tenant.isInTransaction.mockReturnValue(true);
    await expect(h.repo.listAll({ page: 1, limit: 20 })).rejects.toThrow();
    expect(h.tenant.getClient).not.toHaveBeenCalled();
    h.tenant.isInTransaction.mockReturnValue(false);
    h.tenant.getTenantId.mockImplementation(() => {
      throw new Error('missing tenant');
    });
    await expect(h.repo.listAll({ page: 1, limit: 20 })).rejects.toThrow();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it.each(['transaction', 'count', 'fetch'])(
    'propagates %s failure without fallback',
    async (stage) => {
      const h = harness(1, 1);
      const failure = new Error('read failed');
      if (stage === 'transaction') h.transaction.mockRejectedValueOnce(failure);
      if (stage === 'count')
        h.tx.humanDecision.count.mockReset().mockRejectedValueOnce(failure);
      if (stage === 'fetch')
        h.tx.humanDecision.findMany.mockRejectedValueOnce(failure);
      await expect(h.repo.listAll({ page: 1, limit: 20 })).rejects.toBe(
        failure,
      );
      expect(h.root.humanDecision.findMany).not.toHaveBeenCalled();
    },
  );
});

describe('recent resolved reads', () => {
  it('captures one clock value and shares the inclusive scoped window with count', async () => {
    const client = makeClient();
    arrangeList(client, [], 51);
    const now = new Date('2026-09-30T12:00:00.000Z');
    const clock = jest.fn(() => now);
    const { repo } = makeRepo(client, { clock });
    const query = {
      page: 2,
      limit: 50,
      search: 'Cafe%_\\',
      status: 'PENDING',
      sortBy: 'createdAt',
      sortOrder: 'asc',
    };
    expect(await repo.listResolved(query)).toEqual({
      items: [],
      pageIndex0: 1,
      pageSize: 50,
      totalCount: 51,
      pageCount: 2,
    });
    expect(clock).toHaveBeenCalledTimes(1);
    const [[args]] = client.humanDecision.findMany.mock.calls as [
      [CapturedFindManyArgs],
    ];
    expect(args.where).toEqual({
      tenantId: TENANT_ID,
      source: RESTOCK_SOURCE,
      type: RESTOCK_TYPE,
      status: 'RESOLVED',
      resolvedAt: { gte: new Date(now.getTime() - 604800000), lte: now },
      productName: { contains: 'Cafe\\%\\_\\\\', mode: 'insensitive' },
    });
    const [[countArgs]] = client.humanDecision.count.mock.calls as [
      [{ where: unknown }],
    ];
    expect(countArgs.where).toBe(args.where);
    expect(args.orderBy).toEqual([{ resolvedAt: 'desc' }, { id: 'asc' }]);
    expect([args.skip, args.take]).toEqual([50, 50]);
    expect(Object.keys(args.select).sort()).toEqual(REVIEW_SELECT_KEYS);
  });

  it('does not read without tenant context and keeps pending clock-free', async () => {
    const client = makeClient();
    arrangeList(client, []);
    const clock = jest.fn(() => new Date());
    await expect(
      makeRepo(client, { tenantId: null, clock }).repo.listResolved({
        page: 1,
        limit: 20,
      }),
    ).rejects.toThrow();
    expect(client.humanDecision.findMany).not.toHaveBeenCalled();
    await makeRepo(client, { clock }).repo.listPending({ page: 1, limit: 20 });
    expect(clock).not.toHaveBeenCalled();
  });

  it.each([
    { page: 0, limit: 20 },
    { page: 1, limit: 21 },
    { page: 1, limit: 20, search: '' },
  ])('rejects unsafe resolved query %p', async (query) => {
    const client = makeClient();
    await expect(
      makeRepo(client).repo.listResolved(query),
    ).rejects.toBeInstanceOf(HumanDecisionReviewReadError);
    expect(client.humanDecision.findMany).not.toHaveBeenCalled();
    expect(client.humanDecision.count).not.toHaveBeenCalled();
  });
});

function arrangeList(
  client: ClientMock,
  records: HumanDecisionReviewRecord[] = [makeRecord()],
  totalCount = records.length,
): void {
  client.humanDecision.findMany.mockResolvedValue(records);
  client.humanDecision.count.mockResolvedValue(totalCount);
}

function findManyArgs(client: ClientMock, call = 0): CapturedFindManyArgs {
  const calls = client.humanDecision.findMany.mock.calls as Array<
    [CapturedFindManyArgs]
  >;
  return calls[call][0];
}

function findFirstArgs(client: ClientMock): CapturedFindFirstArgs {
  const calls = client.humanDecision.findFirst.mock.calls as Array<
    [CapturedFindFirstArgs]
  >;
  return calls[0][0];
}

describe('PrismaHumanDecisionReviewReadRepository', () => {
  describe('listPending — tenant scope and list contract', () => {
    it('scopes where to the tenant, RESTOCK source/type and a hardcoded PENDING status', async () => {
      const client = makeClient();
      arrangeList(client);
      const { repo } = makeRepo(client);

      await repo.listPending({ page: 1, limit: 20 });

      expect(client.humanDecision.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId: TENANT_ID,
            source: RESTOCK_SOURCE,
            type: RESTOCK_TYPE,
            status: 'PENDING',
          },
        }),
      );
    });

    it('ignores a caller-supplied status and never widens the queue', async () => {
      const client = makeClient();
      arrangeList(client);
      const { repo } = makeRepo(client);

      await repo.listPending({
        page: 1,
        limit: 20,
        status: 'RESOLVED',
      } as unknown as HumanDecisionReviewListQuery);

      expect(findManyArgs(client).where.status).toBe('PENDING');
      expect(findManyArgs(client).where).not.toHaveProperty(
        'status',
        'RESOLVED',
      );
    });

    it('sends the identical where to count and findMany', async () => {
      const client = makeClient();
      arrangeList(client, [makeRecord()], 7);
      const { repo } = makeRepo(client);

      await repo.listPending({ page: 1, limit: 20 });

      const countCalls = client.humanDecision.count.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >;
      expect(countCalls[0][0].where).toEqual(findManyArgs(client).where);
    });

    it('orders by createdAt asc then id asc for a stable queue', async () => {
      const client = makeClient();
      arrangeList(client);
      const { repo } = makeRepo(client);

      await repo.listPending({ page: 1, limit: 20 });

      expect(findManyArgs(client).orderBy).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
    });

    it('resolves the tenant from TenantPrismaService before querying', async () => {
      const client = makeClient();
      arrangeList(client);
      const { repo, tenantPrisma } = makeRepo(client);

      await repo.listPending({ page: 1, limit: 20 });

      expect(tenantPrisma.getTenantId).toHaveBeenCalledTimes(1);
      expect(tenantPrisma.getClient).toHaveBeenCalled();
    });

    it('fails closed without a tenant id and runs no query (no superadmin bypass)', async () => {
      const client = makeClient();
      const { repo } = makeRepo(client, { tenantId: null });

      await expect(repo.listPending({ page: 1, limit: 20 })).rejects.toThrow(
        'Tenant context required',
      );

      expect(client.humanDecision.findMany).not.toHaveBeenCalled();
      expect(client.humanDecision.count).not.toHaveBeenCalled();
    });

    it('never uses findUnique for the list', async () => {
      const client = makeClient();
      arrangeList(client);
      const { repo } = makeRepo(client);

      await repo.listPending({ page: 1, limit: 20 });

      expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('listPending — SELECT allowlist', () => {
    it('selects exactly the mapper record fields and no authority/server column', async () => {
      const client = makeClient();
      arrangeList(client);
      const { repo } = makeRepo(client);

      await repo.listPending({ page: 1, limit: 20 });

      const select = findManyArgs(client).select;
      expect(Object.keys(select).sort()).toEqual(REVIEW_SELECT_KEYS);
      for (const forbidden of FORBIDDEN_SELECT_KEYS) {
        expect(select).not.toHaveProperty(forbidden);
      }
    });
  });

  describe('listPending — pagination', () => {
    it('maps page 1 / limit 20 to skip 0, take 20 and the FE shape', async () => {
      const client = makeClient();
      arrangeList(client, [makeRecord()], 21);
      const { repo } = makeRepo(client);

      const page = await repo.listPending({ page: 1, limit: 20 });

      expect(findManyArgs(client).skip).toBe(0);
      expect(findManyArgs(client).take).toBe(20);
      expect(page.pageIndex0).toBe(0);
      expect(page.pageSize).toBe(20);
      expect(page.totalCount).toBe(21);
      expect(page.pageCount).toBe(2);
    });

    it('maps page 3 / limit 50 to the computed offset and take', async () => {
      const client = makeClient();
      arrangeList(client, [makeRecord()], 101);
      const { repo } = makeRepo(client);

      const page = await repo.listPending({ page: 3, limit: 50 });

      expect(findManyArgs(client).skip).toBe(100);
      expect(findManyArgs(client).take).toBe(50);
      expect(page.pageIndex0).toBe(2);
      expect(page.pageSize).toBe(50);
      expect(page.pageCount).toBe(3);
    });

    it('returns a safe empty page for an empty queue', async () => {
      const client = makeClient();
      arrangeList(client, [], 0);
      const { repo } = makeRepo(client);

      const page = await repo.listPending({ page: 1, limit: 20 });

      expect(page).toEqual({
        items: [],
        pageIndex0: 0,
        pageSize: 20,
        totalCount: 0,
        pageCount: 0,
      });
    });
  });

  describe('listPending — argument safety', () => {
    const invalidQueries: Array<[string, { page: number; limit: number }]> = [
      ['page zero', { page: 0, limit: 20 }],
      ['negative page', { page: -1, limit: 20 }],
      ['fractional page', { page: 1.5, limit: 20 }],
      ['NaN page', { page: Number.NaN, limit: 20 }],
      ['unsafe page', { page: Number.MAX_SAFE_INTEGER, limit: 20 }],
      ['zero limit', { page: 1, limit: 0 }],
      ['negative limit', { page: 1, limit: -20 }],
      ['non-whitelisted limit', { page: 1, limit: 10 }],
      ['oversized limit', { page: 1, limit: 100 }],
      ['INT32-overflow skip', { page: 42_949_674, limit: 50 }],
    ];

    it.each(invalidQueries)(
      'rejects %s with a value-free error and no query',
      async (_label, query) => {
        const client = makeClient();
        arrangeList(client);
        const { repo } = makeRepo(client);

        const error: unknown = await repo
          .listPending(query)
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(HumanDecisionReviewReadError);
        if (!(error instanceof HumanDecisionReviewReadError)) {
          throw new Error('expected HumanDecisionReviewReadError');
        }
        expect(error.message).not.toContain(String(query.page));
        expect(error.message).not.toContain(String(query.limit));
        expect(client.humanDecision.findMany).not.toHaveBeenCalled();
        expect(client.humanDecision.count).not.toHaveBeenCalled();
      },
    );

    it('accepts every whitelisted limit', async () => {
      for (const limit of [20, 50]) {
        const client = makeClient();
        arrangeList(client, [], 0);
        const { repo } = makeRepo(client);

        const page = await repo.listPending({ page: 1, limit });

        expect(page.pageSize).toBe(limit);
      }
    });
  });

  describe('listPending — literal search escaping', () => {
    it('omits the productName filter when search is not supplied', async () => {
      const client = makeClient();
      arrangeList(client);
      const { repo } = makeRepo(client);

      await repo.listPending({ page: 1, limit: 20 });

      expect(findManyArgs(client).where).not.toHaveProperty('productName');
    });

    it('searches only the persisted productName insensitively', async () => {
      const client = makeClient();
      arrangeList(client);
      const { repo } = makeRepo(client);

      await repo.listPending({ page: 1, limit: 20, search: 'cafe' });

      expect(findManyArgs(client).where.productName).toEqual({
        contains: 'cafe',
        mode: 'insensitive',
      });
    });

    it.each<[string, string, string]>([
      ['percent wildcard', '%', '\\%'],
      ['underscore wildcard', '_', '\\_'],
      ['backslash escape char', '\\', '\\\\'],
      ['combined wildcards', '50%_off\\', '50\\%\\_off\\\\'],
      ['all three interleaved', '\\%_%_\\', '\\\\\\%\\_\\%\\_\\\\'],
    ])(
      'escapes the %s for a literal substring match',
      async (_label, term, expected) => {
        const client = makeClient();
        arrangeList(client);
        const { repo } = makeRepo(client);

        await repo.listPending({ page: 1, limit: 20, search: term });

        expect(findManyArgs(client).where.productName).toEqual({
          contains: expected,
          mode: 'insensitive',
        });
      },
    );

    it('rejects a blank search with a value-free error and no query', async () => {
      const client = makeClient();
      arrangeList(client);
      const { repo } = makeRepo(client);

      await expect(
        repo.listPending({ page: 1, limit: 20, search: '   ' }),
      ).rejects.toBeInstanceOf(HumanDecisionReviewReadError);
      expect(client.humanDecision.findMany).not.toHaveBeenCalled();
    });

    it('rejects a non-string search without echoing it', async () => {
      const client = makeClient();
      arrangeList(client);
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .listPending({
          page: 1,
          limit: 20,
          search: 12345,
        } as unknown as HumanDecisionReviewListQuery)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewReadError);
      if (!(error instanceof HumanDecisionReviewReadError)) {
        throw new Error('expected HumanDecisionReviewReadError');
      }
      expect(error.message).not.toContain('12345');
      expect(client.humanDecision.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findById — detail', () => {
    it('looks up by id with tenant, source and type but no status restriction', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRecord());
      const { repo } = makeRepo(client);

      await repo.findById(DECISION_ID);

      const args = findFirstArgs(client);
      expect(args.where).toEqual({
        id: DECISION_ID,
        tenantId: TENANT_ID,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
      });
      expect(args.where).not.toHaveProperty('status');
    });

    it('never uses findUnique by id alone', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRecord());
      const { repo } = makeRepo(client);

      await repo.findById(DECISION_ID);

      expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(1);
      expect(client.humanDecision.findMany).not.toHaveBeenCalled();
    });

    it('selects the same mapper allowlist as the list', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRecord());
      const { repo } = makeRepo(client);

      await repo.findById(DECISION_ID);

      const select = findFirstArgs(client).select;
      expect(Object.keys(select).sort()).toEqual(REVIEW_SELECT_KEYS);
      for (const forbidden of FORBIDDEN_SELECT_KEYS) {
        expect(select).not.toHaveProperty(forbidden);
      }
    });

    it('returns the record for a valid tenant-scoped id', async () => {
      const client = makeClient();
      const record = makeRecord();
      client.humanDecision.findFirst.mockResolvedValue(record);
      const { repo } = makeRepo(client);

      await expect(repo.findById(DECISION_ID)).resolves.toEqual(record);
    });

    it('returns a RESOLVED record too (no PENDING-only restriction)', async () => {
      const client = makeClient();
      const resolved = makeRecord({
        status: 'RESOLVED',
        version: 2,
        resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 3,
        resolvedAt: new Date('2026-09-02T00:00:00.000Z'),
        resolvedByActorId: 'user-1',
        resolvedByDisplayName: 'Ana',
      });
      client.humanDecision.findFirst.mockResolvedValue(resolved);
      const { repo } = makeRepo(client);

      await expect(repo.findById(DECISION_ID)).resolves.toEqual(resolved);
    });

    it('returns null for a missing or cross-tenant id', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(null);
      const { repo } = makeRepo(client);

      await expect(repo.findById(DECISION_ID)).resolves.toBeNull();
    });

    it('requires the tenant context before querying', async () => {
      const client = makeClient();
      const { repo } = makeRepo(client, { tenantId: null });

      await expect(repo.findById(DECISION_ID)).rejects.toThrow(
        'Tenant context required',
      );
      expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
    });

    it.each<[string, unknown]>([
      ['empty id', ''],
      ['blank id', '   '],
      ['non-string id', 42],
    ])('rejects a %s with a value-free error', async (_label, id) => {
      const client = makeClient();
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .findById(id as string)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewReadError);
      expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('error passthrough', () => {
    it('rethrows an unrelated database failure untouched for the list', async () => {
      const client = makeClient();
      const failure = new Error('connection reset');
      client.humanDecision.findMany.mockRejectedValue(failure);
      client.humanDecision.count.mockResolvedValue(0);
      const { repo } = makeRepo(client);

      await expect(repo.listPending({ page: 1, limit: 20 })).rejects.toBe(
        failure,
      );
    });

    it('rethrows an unrelated database failure untouched for the detail', async () => {
      const client = makeClient();
      const failure = new Error('connection reset');
      client.humanDecision.findFirst.mockRejectedValue(failure);
      const { repo } = makeRepo(client);

      await expect(repo.findById(DECISION_ID)).rejects.toBe(failure);
    });
  });
});
