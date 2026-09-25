/**
 * HD-05b — PrismaBotRestockPollRepository DB-free behavior spec.
 *
 * Mocks `TenantPrismaService` (`getClient` / `getTenantId`) so no PostgreSQL
 * roundtrip happens. These tests prove the adapter seams: the full pinned
 * WHERE predicate, the exact `BOT_POLL_RECORD_SELECT` allowlist, the explicit
 * flat-row -> nested-record conversion (no spread / full-row passthrough),
 * `PENDING`/`RESOLVED` projection, cross-tenant `null`, the tenantless
 * fail-closed path (no superadmin bypass) and a value-free bypass-argument
 * error.
 *
 * These mocked tests do NOT prove real PostgreSQL CLS/tenant-extension
 * behavior nor the bot HTTP route; HD-05c owns the HTTP slice.
 */

import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  BotRestockPollReadError,
  type BotRestockPollRecord,
  type BotRestockPollSnapshotRecord,
} from '../domain/bot-restock-poll.repository';
import {
  HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
} from '../domain/human-decision-review-resolve.repository';
import {
  BOT_POLL_RECORD_SELECT,
  PrismaBotRestockPollRepository,
} from './prisma-bot-restock-poll.repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DECISION_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const PRODUCT_ID = '44444444-4444-4444-8444-444444444444';
const VARIANT_ID = '55555555-5555-4555-8555-555555555555';
const SUPERSEDES_ID = '66666666-6666-4666-8666-666666666666';
const BRANCH_ID = 'branch-1';
const BRANCH_NAME = 'Sucursal Centro';
const PRODUCT_NAME = 'Filtro de aceite';
const SKU = 'SKU-1';
const REQUESTED_QUANTITY = 3;
const OBSERVED_STOCK = 0;
const RESTOCK_DAYS = 5;
const CREATED_AT = new Date('2026-02-01T10:00:00.000Z');
const OBSERVED_AT = new Date('2026-01-31T23:30:00.000Z');
const RESOLVED_AT = new Date('2026-02-01T23:30:00.000Z');

/** Flat row exactly as `BOT_POLL_RECORD_SELECT` produces it. */
interface PollRow {
  id: string;
  sourceRequestId: string;
  type: string;
  status: string;
  version: number;
  createdAt: Date;
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  variantId: string | null;
  sku: string | null;
  requestedQuantity: number | null;
  observedStockAtRequest: number | null;
  stockObservedAt: Date | null;
  supersedesDecisionId: string | null;
  resolutionAction: string | null;
  restockDays: number | null;
  resolvedAt: Date | null;
}

const EXPECTED_SELECT_KEYS = [
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
  'restockDays',
  'sku',
  'sourceRequestId',
  'status',
  'stockObservedAt',
  'supersedesDecisionId',
  'type',
  'variantId',
  'version',
];

/** Authority/reviewer/credential/provider/outcome/PII columns that must never leak. */
const FORBIDDEN_SELECT_KEYS = [
  'tenantId',
  'source',
  'canonicalRequestHash',
  'submittedCredentialId',
  'resolutionRequestId',
  'resolvedById',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'resolvedBy',
  'applicationOutcome',
  'applicationAttemptId',
  'applicationEvidenceHash',
  'applicationEvidenceCode',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'applicationAttemptedAt',
  'ackReceivedAt',
  'updatedAt',
  'customerPhone',
  'transcript',
];

const POLL_RECORD_TOP_LEVEL_KEYS = [
  'id',
  'sourceRequestId',
  'type',
  'status',
  'version',
  'createdAt',
  'snapshot',
  'supersedesDecisionId',
  'resolutionAction',
  'restockDays',
  'resolvedAt',
];

const SNAPSHOT_KEYS = [
  'branchId',
  'branchName',
  'productId',
  'productName',
  'variantId',
  'sku',
  'requestedQuantity',
  'observedStockAtRequest',
  'stockObservedAt',
];

const PENDING_SNAPSHOT: BotRestockPollSnapshotRecord = {
  branchId: BRANCH_ID,
  branchName: BRANCH_NAME,
  productId: PRODUCT_ID,
  productName: PRODUCT_NAME,
  variantId: VARIANT_ID,
  sku: SKU,
  requestedQuantity: REQUESTED_QUANTITY,
  observedStockAtRequest: OBSERVED_STOCK,
  stockObservedAt: OBSERVED_AT,
};

function makeRow(overrides: Partial<PollRow> = {}): PollRow {
  return {
    id: DECISION_ID,
    sourceRequestId: SOURCE_REQUEST_ID,
    type: RESTOCK_TYPE,
    status: 'PENDING',
    version: 1,
    createdAt: CREATED_AT,
    branchId: BRANCH_ID,
    branchName: BRANCH_NAME,
    productId: PRODUCT_ID,
    productName: PRODUCT_NAME,
    variantId: VARIANT_ID,
    sku: SKU,
    requestedQuantity: REQUESTED_QUANTITY,
    observedStockAtRequest: OBSERVED_STOCK,
    stockObservedAt: OBSERVED_AT,
    supersedesDecisionId: null,
    resolutionAction: null,
    restockDays: null,
    resolvedAt: null,
    ...overrides,
  };
}

function resolvedRow(overrides: Partial<PollRow> = {}): PollRow {
  return makeRow({
    status: 'RESOLVED',
    version: 2,
    resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
    restockDays: RESTOCK_DAYS,
    resolvedAt: RESOLVED_AT,
    ...overrides,
  });
}

interface CapturedFindFirstArgs {
  where: Record<string, unknown>;
  select: Record<string, boolean>;
}

interface ClientMock {
  humanDecision: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
}

function makeClient(): ClientMock {
  return {
    humanDecision: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
  };
}

function makeRepo(
  client: ClientMock,
  options: { tenantId?: string | null } = {},
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
  const repo = new PrismaBotRestockPollRepository(
    tenantPrisma as unknown as TenantPrismaService,
  );
  return { repo, tenantPrisma };
}

function findFirstArgs(client: ClientMock, call = 0): CapturedFindFirstArgs {
  const calls = client.humanDecision.findFirst.mock.calls as Array<
    [CapturedFindFirstArgs]
  >;
  return calls[call][0];
}

describe('PrismaBotRestockPollRepository', () => {
  describe('findById — pinned tenant/source/type predicate', () => {
    it('queries with the full pinned where predicate and no status filter', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRow());
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

    it('calls findFirst with exactly where and select (no pagination/order extras)', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRow());
      const { repo } = makeRepo(client);

      await repo.findById(DECISION_ID);

      expect(Object.keys(findFirstArgs(client)).sort()).toEqual([
        'select',
        'where',
      ]);
    });

    it('never reaches Prisma with findUnique or a broader query', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRow());
      const { repo } = makeRepo(client);

      await repo.findById(DECISION_ID);

      expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(1);
      expect(client.humanDecision.findUnique).not.toHaveBeenCalled();
      expect(client.humanDecision.findMany).not.toHaveBeenCalled();
    });

    it('resolves the tenant from TenantPrismaService before querying', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRow());
      const { repo, tenantPrisma } = makeRepo(client);

      await repo.findById(DECISION_ID);

      expect(tenantPrisma.getTenantId).toHaveBeenCalledTimes(1);
      expect(tenantPrisma.getClient).toHaveBeenCalled();
    });

    it('fails closed without a tenant id and runs no query (no superadmin bypass)', async () => {
      const client = makeClient();
      const { repo, tenantPrisma } = makeRepo(client, { tenantId: null });

      await expect(repo.findById(DECISION_ID)).rejects.toThrow(
        'Tenant context required',
      );

      expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
      expect(tenantPrisma.getClient).not.toHaveBeenCalled();
    });
  });

  describe('findById — SELECT allowlist', () => {
    it('selects exactly the 19 mapper fields and no authority/reviewer column', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRow());
      const { repo } = makeRepo(client);

      await repo.findById(DECISION_ID);

      const select = findFirstArgs(client).select;
      expect(Object.keys(select).sort()).toEqual(EXPECTED_SELECT_KEYS);
      for (const forbidden of FORBIDDEN_SELECT_KEYS) {
        expect(select).not.toHaveProperty(forbidden);
      }
    });

    it('passes the exact exported BOT_POLL_RECORD_SELECT constant', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRow());
      const { repo } = makeRepo(client);

      await repo.findById(DECISION_ID);

      expect(findFirstArgs(client).select).toEqual(BOT_POLL_RECORD_SELECT);
    });
  });

  describe('findById — flat-row to nested-record projection', () => {
    it('projects a PENDING row into the nested poll record', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRow());
      const { repo } = makeRepo(client);

      const expected: BotRestockPollRecord = {
        id: DECISION_ID,
        sourceRequestId: SOURCE_REQUEST_ID,
        type: RESTOCK_TYPE,
        status: 'PENDING',
        version: 1,
        createdAt: CREATED_AT,
        snapshot: PENDING_SNAPSHOT,
        supersedesDecisionId: null,
        resolutionAction: null,
        restockDays: null,
        resolvedAt: null,
      };

      await expect(repo.findById(DECISION_ID)).resolves.toEqual(expected);
    });

    it('projects a RESOLVED positive-resolution row with its mutable columns', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(resolvedRow());
      const { repo } = makeRepo(client);

      const expected: BotRestockPollRecord = {
        id: DECISION_ID,
        sourceRequestId: SOURCE_REQUEST_ID,
        type: RESTOCK_TYPE,
        status: 'RESOLVED',
        version: 2,
        createdAt: CREATED_AT,
        snapshot: PENDING_SNAPSHOT,
        supersedesDecisionId: null,
        resolutionAction: HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
        restockDays: RESTOCK_DAYS,
        resolvedAt: RESOLVED_AT,
      };

      await expect(repo.findById(DECISION_ID)).resolves.toEqual(expected);
    });

    it('projects a RESOLVED negative-resolution row without fabricating restockDays', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(
        resolvedRow({
          resolutionAction: HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
          restockDays: null,
        }),
      );
      const { repo } = makeRepo(client);

      const record = await repo.findById(DECISION_ID);

      expect(record?.resolutionAction).toBe(
        HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
      );
      expect(record?.restockDays).toBeNull();
      expect(record?.resolvedAt).toEqual(RESOLVED_AT);
    });

    it('carries the supersession link when present', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(
        makeRow({ supersedesDecisionId: SUPERSEDES_ID }),
      );
      const { repo } = makeRepo(client);

      const record = await repo.findById(DECISION_ID);

      expect(record?.supersedesDecisionId).toBe(SUPERSEDES_ID);
    });

    it('drops forbidden columns injected on the returned row (no spread / full-row passthrough)', async () => {
      const client = makeClient();
      const widenedRow = {
        ...makeRow({ supersedesDecisionId: SUPERSEDES_ID }),
        source: RESTOCK_SOURCE,
        tenantId: TENANT_ID,
        canonicalRequestHash: 'hash-sentinel',
        submittedCredentialId: 'credential-sentinel',
        resolutionRequestId: 'resolution-request-sentinel',
        resolvedById: 'user-sentinel',
        resolvedByActorId: 'user-sentinel',
        resolvedByDisplayName: 'Reviewer Sentinel',
        resolvedBy: { id: 'user-sentinel' },
        applicationOutcome: 'PROVIDER_ACCEPTED',
        applicationAttemptId: 'attempt-sentinel',
        applicationEvidenceHash: 'evidence-hash-sentinel',
        applicationEvidenceCode: 'evidence-code-sentinel',
        providerMessageId: 'provider-sentinel',
        providerAcceptedObservedAt: RESOLVED_AT,
        applicationAttemptedAt: RESOLVED_AT,
        ackReceivedAt: RESOLVED_AT,
        updatedAt: RESOLVED_AT,
        customerPhone: '555-sentinel',
        transcript: 'transcript-sentinel',
      };
      client.humanDecision.findFirst.mockResolvedValue(widenedRow);
      const { repo } = makeRepo(client);

      const record = await repo.findById(DECISION_ID);

      expect(record).not.toBeNull();
      if (record === null) {
        throw new Error('expected a projected record');
      }
      expect(Object.keys(record).sort()).toEqual(
        [...POLL_RECORD_TOP_LEVEL_KEYS].sort(),
      );
      expect(Object.keys(record.snapshot).sort()).toEqual(
        [...SNAPSHOT_KEYS].sort(),
      );
      for (const forbidden of FORBIDDEN_SELECT_KEYS) {
        expect(record).not.toHaveProperty(forbidden);
        expect(record.snapshot).not.toHaveProperty(forbidden);
      }
    });

    it('returns a fresh snapshot object that does not alias the persisted row', async () => {
      const client = makeClient();
      const row = makeRow();
      client.humanDecision.findFirst.mockResolvedValue(row);
      const { repo } = makeRepo(client);

      const record = await repo.findById(DECISION_ID);

      expect(record?.snapshot).not.toBe(row);
      expect(record?.snapshot).toEqual(PENDING_SNAPSHOT);
    });
  });

  describe('findById — missing / cross-tenant', () => {
    it('returns null for a missing, cross-tenant or foreign-source id', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(null);
      const { repo } = makeRepo(client);

      await expect(repo.findById(DECISION_ID)).resolves.toBeNull();
    });
  });

  describe('findById — bypass argument safety', () => {
    it.each<[string, unknown]>([
      ['empty id', ''],
      ['blank id', '   '],
      ['non-string number', 42],
      ['non-string object', { id: DECISION_ID }],
      ['null id', null],
      ['undefined id', undefined],
      ['non-canonical uuid', 'not-a-uuid'],
      ['nil uuid', '00000000-0000-0000-0000-000000000000'],
      ['uppercase uuid', '2B7C1A90-6F3E-4D2A-8B1C-0D9E8F7A6B5C'],
      ['trimmed uuid', ` ${DECISION_ID} `],
    ])(
      'rejects a %s with a value-free error and no query',
      async (_label, id) => {
        const client = makeClient();
        const { repo } = makeRepo(client);

        const error: unknown = await repo
          .findById(id as string)
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BotRestockPollReadError);
        if (!(error instanceof BotRestockPollReadError)) {
          throw new Error('expected BotRestockPollReadError');
        }
        expect(error.code).toBe('INVALID_READ_ARGUMENT');
        expect(error.message).toBe('Invalid bot restock poll read argument');
        expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
      },
    );
  });

  describe('findById — error passthrough', () => {
    it('rethrows an unrelated database failure untouched', async () => {
      const client = makeClient();
      const failure = new Error('connection reset');
      client.humanDecision.findFirst.mockRejectedValue(failure);
      const { repo } = makeRepo(client);

      await expect(repo.findById(DECISION_ID)).rejects.toBe(failure);
    });
  });
});
