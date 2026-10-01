/**
 * HD-04c2 — PrismaHumanDecisionReviewResolveRepository DB-free behavior spec.
 *
 * Mocks `TenantPrismaService` (`isInTransaction` / `getTenantId` /
 * `getClient` / `runInTransaction`) so no PostgreSQL roundtrip happens. These
 * tests prove the adapter seams: the ambient-transaction guard, the
 * unconditional CLS tenant resolution, the server-derived reviewer
 * verification (active `User` + explicit tenant membership, superadmin
 * bypass), the exact one-winner CAS (where + immutable snapshot data), the
 * `count === 0` loser classification, the idempotent replay/conflict codes,
 * the sanitized `NOT_FOUND`, the reviewer-projection SELECT allowlist, and that
 * no out-of-scope model is ever mutated.
 *
 * These mocked tests do NOT prove real PostgreSQL row locking or an actual
 * two-reviewer race. HD-04c3 owns the dedicated local PostgreSQL integration
 * proof against the isolated RESTOCK database.
 */
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
  HumanDecisionReviewResolveError,
  type ResolveHumanDecisionProvideCommand,
  type ResolveHumanDecisionUnavailableCommand,
} from '../domain/human-decision-review-resolve.repository';
import { PrismaHumanDecisionReviewResolveRepository } from './prisma-human-decision-review-resolve.repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DECISION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const RESOLUTION_REQUEST_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const OTHER_RESOLUTION_REQUEST_ID = '0192a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';
const ACTOR_NAME = 'Ana Reviewer';
const FIXED_NOW = new Date('2026-09-03T12:00:00.000Z');

/** Exact reviewer projection allowlist shared with the read adapter. */
const REVIEW_SELECT_KEYS = [
  'branchId',
  'branchName',
  'createdAt',
  'expirationText',
  'id',
  'observedStockAtRequest',
  'productId',
  'productName',
  'productUnit',
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
  'variantName',
  'variantOption',
  'variantValue',
  'version',
];

/** Authority/credential/provider/PII columns the response must never select. */
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

/** Exact CAS mutation payload keys; no bot/provider/stock/outcome field. */
const RESOLUTION_DATA_KEYS = [
  'resolutionAction',
  'resolutionRequestId',
  'resolvedAt',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'resolvedById',
  'restockDays',
  'status',
  'version',
];

/** Exact one-winner CAS predicate keys. */
const CAS_WHERE_KEYS = [
  'id',
  'source',
  'status',
  'tenantId',
  'type',
  'version',
];

interface ClientMock {
  user: { findUnique: jest.Mock };
  tenantMembership: { findFirst: jest.Mock };
  humanDecision: {
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
    deleteMany: jest.Mock;
  };
  sale: { updateMany: jest.Mock; update: jest.Mock; create: jest.Mock };
  product: { updateMany: jest.Mock; update: jest.Mock; create: jest.Mock };
  tenant: { update: jest.Mock; updateMany: jest.Mock };
}

interface CapturedUpdateMany {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface CapturedFindFirst {
  where: Record<string, unknown>;
  select: Record<string, boolean>;
}

interface RepoOptions {
  tenantId?: string | null;
  inTransaction?: boolean;
}

function makeClient(): ClientMock {
  return {
    user: { findUnique: jest.fn() },
    tenantMembership: { findFirst: jest.fn() },
    humanDecision: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    sale: {
      updateMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    product: {
      updateMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    tenant: { update: jest.fn(), updateMany: jest.fn() },
  };
}

function makeRepo(client: ClientMock, options: RepoOptions = {}) {
  const tenantId =
    options.tenantId === undefined ? TENANT_ID : options.tenantId;
  const tenantPrisma = {
    isInTransaction: jest.fn(() => options.inTransaction === true),
    getTenantId: jest.fn(() => {
      if (!tenantId) {
        throw new Error('Tenant context required');
      }
      return tenantId;
    }),
    getClient: jest.fn(() => client),
    runInTransaction: jest.fn(
      async (work: () => Promise<unknown>): Promise<unknown> => work(),
    ),
  };
  const repo = new PrismaHumanDecisionReviewResolveRepository(
    tenantPrisma as unknown as TenantPrismaService,
    () => FIXED_NOW,
  );
  return { repo, tenantPrisma };
}

function arrangeReviewer(
  client: ClientMock,
  actorId = ACTOR_ID,
  name = ACTOR_NAME,
  isActive = true,
): void {
  client.user.findUnique.mockResolvedValue({ id: actorId, name, isActive });
  client.tenantMembership.findFirst.mockResolvedValue({ id: 'membership-1' });
}

function pendingState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: DECISION_ID,
    status: 'PENDING',
    version: 1,
    resolutionRequestId: null,
    resolutionAction: null,
    restockDays: null,
    resolvedByActorId: null,
    ...overrides,
  };
}

function resolvedState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: DECISION_ID,
    status: 'RESOLVED',
    version: 2,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
    resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
    restockDays: 7,
    resolvedByActorId: ACTOR_ID,
    ...overrides,
  };
}

function resolvedRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: DECISION_ID,
    type: RESTOCK_TYPE,
    status: 'RESOLVED',
    version: 2,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    branchId: TENANT_ID,
    branchName: 'Sucursal Centro',
    productId: '55555555-5555-4555-8555-555555555555',
    productName: 'Cafe de altura',
    variantId: null,
    sku: null,
    requestedQuantity: 5,
    observedStockAtRequest: 0,
    stockObservedAt: new Date('2026-09-01T10:00:00.000Z'),
    resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
    restockDays: 7,
    resolvedAt: FIXED_NOW,
    resolvedByActorId: ACTOR_ID,
    resolvedByDisplayName: ACTOR_NAME,
    ...overrides,
  };
}

function positiveCommand(
  overrides: Partial<ResolveHumanDecisionProvideCommand> = {},
): ResolveHumanDecisionProvideCommand {
  return {
    decisionId: DECISION_ID,
    expectedVersion: 1,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
    action: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
    restockDays: 7,
    actorUserId: ACTOR_ID,
    actorIsSuperAdmin: false,
    ...overrides,
  };
}

function negativeCommand(
  overrides: Partial<ResolveHumanDecisionUnavailableCommand> = {},
): ResolveHumanDecisionUnavailableCommand {
  return {
    decisionId: DECISION_ID,
    expectedVersion: 1,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
    action: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
    actorUserId: ACTOR_ID,
    actorIsSuperAdmin: false,
    ...overrides,
  };
}

function updateManyArgs(client: ClientMock, call = 0): CapturedUpdateMany {
  const calls = client.humanDecision.updateMany.mock.calls as Array<
    [CapturedUpdateMany]
  >;
  return calls[call][0];
}

function findFirstArgs(client: ClientMock, call = 0): CapturedFindFirst {
  const calls = client.humanDecision.findFirst.mock.calls as Array<
    [CapturedFindFirst]
  >;
  return calls[call][0];
}

describe('PrismaHumanDecisionReviewResolveRepository', () => {
  describe('resolve — happy path one-winner CAS', () => {
    it('resolves a PENDING decision with a positive estimate and persists the reviewer snapshot', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(resolvedRecord());
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      const result = await repo.resolve(positiveCommand());

      expect(result).toEqual({
        status: 'resolved',
        decision: resolvedRecord(),
      });
      expect(client.humanDecision.updateMany).toHaveBeenCalledTimes(1);
      expect(updateManyArgs(client).where).toEqual({
        id: DECISION_ID,
        tenantId: TENANT_ID,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
        status: 'PENDING',
        version: 1,
      });
      expect(updateManyArgs(client).data).toEqual({
        status: 'RESOLVED',
        version: 2,
        resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
        restockDays: 7,
        resolutionRequestId: RESOLUTION_REQUEST_ID,
        resolvedAt: FIXED_NOW,
        resolvedById: ACTOR_ID,
        resolvedByActorId: ACTOR_ID,
        resolvedByDisplayName: ACTOR_NAME,
      });
    });

    it('resolves a PENDING decision with the negative action and stores null restockDays', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      const negativeRecord = resolvedRecord({
        resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
        restockDays: null,
      });
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(negativeRecord);
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      const result = await repo.resolve(negativeCommand());

      expect(result).toEqual({ status: 'resolved', decision: negativeRecord });
      expect(updateManyArgs(client).data).toEqual({
        status: 'RESOLVED',
        version: 2,
        resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
        restockDays: null,
        resolutionRequestId: RESOLUTION_REQUEST_ID,
        resolvedAt: FIXED_NOW,
        resolvedById: ACTOR_ID,
        resolvedByActorId: ACTOR_ID,
        resolvedByDisplayName: ACTOR_NAME,
      });
    });

    it('reads the committed projection with the tenant/source/type predicate', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(resolvedRecord());
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.resolve(positiveCommand());

      expect(findFirstArgs(client, 0).where).toEqual({
        id: DECISION_ID,
        tenantId: TENANT_ID,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
      });
      expect(findFirstArgs(client, 1).where).toEqual({
        id: DECISION_ID,
        tenantId: TENANT_ID,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
      });
    });

    it('resolves the tenant from the CLS context before opening the transaction', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(resolvedRecord());
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo, tenantPrisma } = makeRepo(client);

      await repo.resolve(positiveCommand());

      expect(tenantPrisma.getTenantId).toHaveBeenCalledTimes(1);
      expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
      expect(tenantPrisma.getClient).toHaveBeenCalled();
    });
  });

  describe('resolve — idempotent replay', () => {
    it('replays an exact positive resolution without mutating and preserves resolvedAt', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      const projection = resolvedRecord();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedState())
        .mockResolvedValueOnce(projection);
      const { repo } = makeRepo(client);

      const result = await repo.resolve(positiveCommand());

      expect(result).toEqual({ status: 'replayed', decision: projection });
      expect(result.decision.resolvedAt).toBe(FIXED_NOW);
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it('replays an exact negative resolution without mutating', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      const projection = resolvedRecord({
        resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
        restockDays: null,
      });
      client.humanDecision.findFirst
        .mockResolvedValueOnce(
          resolvedState({
            resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
            restockDays: null,
          }),
        )
        .mockResolvedValueOnce(projection);
      const { repo } = makeRepo(client);

      const result = await repo.resolve(negativeCommand());

      expect(result).toEqual({ status: 'replayed', decision: projection });
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('resolve — same-key conflicts', () => {
    it.each<
      [
        string,
        Record<string, unknown>,
        () => ReturnType<typeof positiveCommand>,
      ]
    >([
      [
        'different action',
        {
          resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
          restockDays: null,
        },
        () => positiveCommand(),
      ],
      [
        'different days',
        { restockDays: 3 },
        () => positiveCommand({ restockDays: 7 }),
      ],
      [
        'different actor',
        { resolvedByActorId: ACTOR_ID },
        () => positiveCommand({ actorUserId: OTHER_ACTOR_ID }),
      ],
      [
        'non-replay expectedVersion',
        {},
        () => positiveCommand({ expectedVersion: 2 }),
      ],
    ])(
      'classifies a same-key %s as IDEMPOTENCY_CONFLICT',
      async (_label, stateOverrides, commandFactory) => {
        const client = makeClient();
        arrangeReviewer(client, OTHER_ACTOR_ID);
        client.humanDecision.findFirst.mockResolvedValueOnce(
          resolvedState(stateOverrides),
        );
        const { repo } = makeRepo(client);

        const error: unknown = await repo
          .resolve(commandFactory())
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
        if (!(error instanceof HumanDecisionReviewResolveError)) {
          throw new Error('expected HumanDecisionReviewResolveError');
        }
        expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
        expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
        expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(1);
      },
    );

    it('classifies a different key against a resolved decision as ALREADY_RESOLVED', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst.mockResolvedValueOnce(resolvedState());
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .resolve(
          positiveCommand({ resolutionRequestId: OTHER_RESOLUTION_REQUEST_ID }),
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
      if (!(error instanceof HumanDecisionReviewResolveError)) {
        throw new Error('expected HumanDecisionReviewResolveError');
      }
      expect(error.code).toBe('ALREADY_RESOLVED');
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('resolve — stale expectedVersion', () => {
    it('rejects a stale expectedVersion on a PENDING decision with VERSION_CONFLICT', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst.mockResolvedValueOnce(pendingState());
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .resolve(positiveCommand({ expectedVersion: 2 }))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
      if (!(error instanceof HumanDecisionReviewResolveError)) {
        throw new Error('expected HumanDecisionReviewResolveError');
      }
      expect(error.code).toBe('VERSION_CONFLICT');
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('resolve — losing CAS (updateMany count 0)', () => {
    it('classifies a losing update against the committed different-key winner as ALREADY_RESOLVED', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(
          resolvedState({ resolutionRequestId: OTHER_RESOLUTION_REQUEST_ID }),
        );
      client.humanDecision.updateMany.mockResolvedValue({ count: 0 });
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .resolve(positiveCommand())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
      if (!(error instanceof HumanDecisionReviewResolveError)) {
        throw new Error('expected HumanDecisionReviewResolveError');
      }
      expect(error.code).toBe('ALREADY_RESOLVED');
      expect(client.humanDecision.updateMany).toHaveBeenCalledTimes(1);
      expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(2);
    });

    it('classifies a losing update against the committed same-key winner as a replay', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      const projection = resolvedRecord();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(resolvedState())
        .mockResolvedValueOnce(projection);
      client.humanDecision.updateMany.mockResolvedValue({ count: 0 });
      const { repo } = makeRepo(client);

      const result = await repo.resolve(positiveCommand());

      expect(result).toEqual({ status: 'replayed', decision: projection });
      expect(client.humanDecision.updateMany).toHaveBeenCalledTimes(1);
    });

    it('classifies a losing update against a changed same-key winner as IDEMPOTENCY_CONFLICT', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(resolvedState({ restockDays: 9 }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 0 });
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .resolve(positiveCommand({ restockDays: 7 }))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
      if (!(error instanceof HumanDecisionReviewResolveError)) {
        throw new Error('expected HumanDecisionReviewResolveError');
      }
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('fails closed when the losing reread finds no committed winner', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(null);
      client.humanDecision.updateMany.mockResolvedValue({ count: 0 });
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .resolve(positiveCommand())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
      if (!(error instanceof HumanDecisionReviewResolveError)) {
        throw new Error('expected HumanDecisionReviewResolveError');
      }
      expect(error.code).toBe('VERSION_CONFLICT');
    });
  });

  describe('resolve — unexpected updateMany count (integrity guard)', () => {
    it.each<[string, number]>([
      ['negative', -1],
      ['two', 2],
      ['large', 42],
    ])(
      'fails closed with a value-free plain Error for a %s count, with no replay or second mutation',
      async (_label, count) => {
        const client = makeClient();
        arrangeReviewer(client);
        client.humanDecision.findFirst.mockResolvedValueOnce(pendingState());
        client.humanDecision.updateMany.mockResolvedValue({ count });
        const { repo } = makeRepo(client);

        const error: unknown = await repo
          .resolve(positiveCommand())
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(HumanDecisionReviewResolveError);
        if (!(error instanceof Error)) {
          throw new Error('expected an Error');
        }
        expect((error as { code?: unknown }).code).toBeUndefined();
        expect(error.message).not.toContain(DECISION_ID);
        expect(error.message).not.toContain(String(count));
        // No loser reread (findFirst once for the decision state) and no
        // second mutation or projection read.
        expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(1);
        expect(client.humanDecision.updateMany).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('resolve — not found / tenant isolation', () => {
    it('returns a sanitized NOT_FOUND for a missing decision and runs no mutation', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst.mockResolvedValueOnce(null);
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .resolve(positiveCommand())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
      if (!(error instanceof HumanDecisionReviewResolveError)) {
        throw new Error('expected HumanDecisionReviewResolveError');
      }
      expect(error.code).toBe('NOT_FOUND');
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it('treats a cross-tenant or foreign-source decision as NOT_FOUND (no existence leak)', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst.mockResolvedValueOnce(null);
      const { repo } = makeRepo(client);

      await expect(repo.resolve(positiveCommand())).rejects.toBeInstanceOf(
        HumanDecisionReviewResolveError,
      );

      expect(findFirstArgs(client, 0).where).toEqual({
        id: DECISION_ID,
        tenantId: TENANT_ID,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
      });
    });
  });

  describe('resolve — reviewer authorization', () => {
    it.each<[string, unknown]>([
      ['missing user', null],
      ['inactive user', { id: ACTOR_ID, name: ACTOR_NAME, isActive: false }],
      ['blank display name', { id: ACTOR_ID, name: '   ', isActive: true }],
    ])(
      'rejects a %s with UNAUTHORIZED and runs no decision query',
      async (_label, actor) => {
        const client = makeClient();
        client.user.findUnique.mockResolvedValue(actor);
        client.tenantMembership.findFirst.mockResolvedValue({
          id: 'membership-1',
        });
        const { repo } = makeRepo(client);

        const error: unknown = await repo
          .resolve(positiveCommand())
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
        if (!(error instanceof HumanDecisionReviewResolveError)) {
          throw new Error('expected HumanDecisionReviewResolveError');
        }
        expect(error.code).toBe('UNAUTHORIZED');
        expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
        expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
      },
    );

    it('rejects an ordinary reviewer without a membership in the CLS tenant with FORBIDDEN', async () => {
      const client = makeClient();
      client.user.findUnique.mockResolvedValue({
        id: ACTOR_ID,
        name: ACTOR_NAME,
        isActive: true,
      });
      client.tenantMembership.findFirst.mockResolvedValue(null);
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .resolve(positiveCommand())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
      if (!(error instanceof HumanDecisionReviewResolveError)) {
        throw new Error('expected HumanDecisionReviewResolveError');
      }
      expect(error.code).toBe('FORBIDDEN');
      expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
    });

    it('validates tenant membership with an explicit userId + tenantId predicate', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(resolvedRecord());
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.resolve(positiveCommand());

      expect(client.tenantMembership.findFirst).toHaveBeenCalledWith({
        where: { userId: ACTOR_ID, tenantId: TENANT_ID },
        select: { id: true },
      });
    });

    it('lets a server-signed superadmin with a selected tenant bypass membership but still requires an active user', async () => {
      const client = makeClient();
      client.user.findUnique.mockResolvedValue({
        id: ACTOR_ID,
        name: ACTOR_NAME,
        isActive: true,
      });
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(resolvedRecord());
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.resolve(positiveCommand({ actorIsSuperAdmin: true }));

      expect(client.tenantMembership.findFirst).not.toHaveBeenCalled();
      expect(client.humanDecision.updateMany).toHaveBeenCalledTimes(1);
    });

    it('still rejects a superadmin when the actor User is missing', async () => {
      const client = makeClient();
      client.user.findUnique.mockResolvedValue(null);
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .resolve(positiveCommand({ actorIsSuperAdmin: true }))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
      if (!(error instanceof HumanDecisionReviewResolveError)) {
        throw new Error('expected HumanDecisionReviewResolveError');
      }
      expect(error.code).toBe('UNAUTHORIZED');
      expect(client.tenantMembership.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('resolve — tenant context fail-closed', () => {
    it.each<[string, boolean]>([
      ['ordinary reviewer', false],
      ['superadmin', true],
    ])(
      'fails closed without a tenant context for a %s before any query',
      async (_label, isSuperAdmin) => {
        const client = makeClient();
        const { repo, tenantPrisma } = makeRepo(client, { tenantId: null });

        await expect(
          repo.resolve(positiveCommand({ actorIsSuperAdmin: isSuperAdmin })),
        ).rejects.toThrow('Tenant context required');

        expect(tenantPrisma.runInTransaction).not.toHaveBeenCalled();
        expect(tenantPrisma.getClient).not.toHaveBeenCalled();
        expect(client.user.findUnique).not.toHaveBeenCalled();
        expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
      },
    );
  });

  describe('resolve — ambient transaction guard', () => {
    it('rejects a nested resolve before any query or tenant lookup', async () => {
      const client = makeClient();
      const { repo, tenantPrisma } = makeRepo(client, { inTransaction: true });

      await expect(repo.resolve(positiveCommand())).rejects.toThrow(
        'must be called outside an ambient transaction',
      );

      expect(tenantPrisma.getTenantId).not.toHaveBeenCalled();
      expect(tenantPrisma.runInTransaction).not.toHaveBeenCalled();
      expect(tenantPrisma.getClient).not.toHaveBeenCalled();
      expect(client.user.findUnique).not.toHaveBeenCalled();
      expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('resolve — mutation scope', () => {
    it('mutates only humanDecision.updateMany and never a bot/provider/stock/sale row', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(resolvedRecord());
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.resolve(positiveCommand());

      const data = updateManyArgs(client).data;
      expect(Object.keys(data).sort()).toEqual(RESOLUTION_DATA_KEYS);
      expect(Object.keys(updateManyArgs(client).where).sort()).toEqual(
        CAS_WHERE_KEYS,
      );
      expect(data).not.toHaveProperty('applicationOutcome');
      expect(data).not.toHaveProperty('applicationAttemptId');
      expect(data).not.toHaveProperty('applicationEvidenceHash');
      expect(data).not.toHaveProperty('providerMessageId');
      expect(data).not.toHaveProperty('providerAcceptedObservedAt');
      expect(data).not.toHaveProperty('ackReceivedAt');

      expect(client.humanDecision.update).not.toHaveBeenCalled();
      expect(client.humanDecision.create).not.toHaveBeenCalled();
      expect(client.humanDecision.deleteMany).not.toHaveBeenCalled();
      expect(client.sale.updateMany).not.toHaveBeenCalled();
      expect(client.sale.update).not.toHaveBeenCalled();
      expect(client.sale.create).not.toHaveBeenCalled();
      expect(client.product.updateMany).not.toHaveBeenCalled();
      expect(client.product.update).not.toHaveBeenCalled();
      expect(client.product.create).not.toHaveBeenCalled();
      expect(client.tenant.update).not.toHaveBeenCalled();
      expect(client.tenant.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('resolve — SELECT allowlist', () => {
    it('returns the exact reviewer projection and no authority/PII column', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(resolvedRecord());
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.resolve(positiveCommand());

      const select = findFirstArgs(client, 1).select;
      expect(Object.keys(select).sort()).toEqual(REVIEW_SELECT_KEYS);
      for (const forbidden of FORBIDDEN_SELECT_KEYS) {
        expect(select).not.toHaveProperty(forbidden);
      }
    });

    it('reads only decision-state fields on the internal classification lookup', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(pendingState())
        .mockResolvedValueOnce(resolvedRecord());
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.resolve(positiveCommand());

      const stateSelect = findFirstArgs(client, 0).select;
      expect(Object.keys(stateSelect).sort()).toEqual([
        'id',
        'resolutionAction',
        'resolutionRequestId',
        'resolvedByActorId',
        'restockDays',
        'status',
        'version',
      ]);
      expect(stateSelect).not.toHaveProperty('productName');
      expect(stateSelect).not.toHaveProperty('submittedCredentialId');
      expect(stateSelect).not.toHaveProperty('canonicalRequestHash');
    });
  });

  describe('resolve — value-free errors', () => {
    it('never echoes the decision id, resolution request id or actor id in an error', async () => {
      const client = makeClient();
      arrangeReviewer(client);
      client.humanDecision.findFirst.mockResolvedValueOnce(resolvedState());
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .resolve(
          positiveCommand({ resolutionRequestId: OTHER_RESOLUTION_REQUEST_ID }),
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HumanDecisionReviewResolveError);
      if (!(error instanceof HumanDecisionReviewResolveError)) {
        throw new Error('expected HumanDecisionReviewResolveError');
      }
      expect(error.message).not.toContain(DECISION_ID);
      expect(error.message).not.toContain(RESOLUTION_REQUEST_ID);
      expect(error.message).not.toContain(OTHER_RESOLUTION_REQUEST_ID);
      expect(error.message).not.toContain(ACTOR_ID);
      expect(error.message).not.toContain(TENANT_ID);
    });
  });
});
