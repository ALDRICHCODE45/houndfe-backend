/**
 * HD-02b1 — PrismaRestockIntakeRepository DB-free behavior spec.
 *
 * Mocks `TenantPrismaService` (`getClient` / `getTenantId` /
 * `runInTransaction`) so no PostgreSQL roundtrip happens. These tests prove
 * the adapter seams: idempotent replay, audit-credential immutability, the
 * tenant/source trust boundary, predecessor STALE eligibility, unique-race
 * recovery and error safety.
 *
 * These mocked tests do NOT prove PostgreSQL uniqueness/CAS/tenant-extension
 * isolation. HD-02b2 owns the real-PostgreSQL proof against the dedicated
 * isolated test DB.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest asymmetric
   matchers (`expect.objectContaining`) are typed `any`; the assertions below
   still pin the exact persisted shape. */
import { Prisma, type HumanDecisionBotOutcome } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  canonicalizeRestockRequest,
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  RestockIntakeError,
  type RestockIntakeInput,
} from '../domain/restock-intake.repository';
import { PrismaRestockIntakeRepository } from './prisma-restock-intake.repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const SOURCE_REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const PRODUCT_ID = '33333333-3333-4333-8333-333333333333';
const VARIANT_ID = '44444444-4444-4444-8444-444444444444';
const PREDECESSOR_ID = '55555555-5555-4555-8555-555555555555';
const STOCK_OBSERVED_AT = '2026-09-01T10:00:00.000Z';
const BRANCH_NAME = 'Sucursal Centro';

type HumanDecisionRecord = Prisma.HumanDecisionGetPayload<true>;

function baseInput(
  overrides: Partial<RestockIntakeInput> = {},
): RestockIntakeInput {
  return {
    sourceRequestId: SOURCE_REQUEST_ID,
    productId: PRODUCT_ID,
    productName: 'Cafe de altura',
    variantId: VARIANT_ID,
    sku: 'SKU-1',
    requestedQuantity: 5,
    observedStockAtRequest: 0,
    stockObservedAt: STOCK_OBSERVED_AT,
    supersedesDecisionId: null,
    submittedCredentialId: 'cred-1',
    ...overrides,
  };
}

function hashFor(input: RestockIntakeInput): string {
  return canonicalizeRestockRequest({ ...input, tenantId: TENANT_ID })
    .requestHash;
}

function makeRecord(
  overrides: Partial<HumanDecisionRecord> = {},
): HumanDecisionRecord {
  return {
    id: 'decision-1',
    tenantId: TENANT_ID,
    source: RESTOCK_SOURCE,
    sourceRequestId: SOURCE_REQUEST_ID,
    type: RESTOCK_TYPE,
    canonicalRequestHash: hashFor(baseInput()),
    submittedCredentialId: 'cred-1',
    branchId: TENANT_ID,
    branchName: BRANCH_NAME,
    productId: PRODUCT_ID,
    productName: 'Cafe de altura',
    variantId: VARIANT_ID,
    sku: 'SKU-1',
    requestedQuantity: 5,
    observedStockAtRequest: 0,
    stockObservedAt: new Date(STOCK_OBSERVED_AT),
    supersedesDecisionId: null,
    status: 'PENDING',
    version: 1,
    resolutionAction: null,
    restockDays: null,
    resolutionRequestId: null,
    resolvedAt: null,
    resolvedById: null,
    resolvedByActorId: null,
    resolvedByDisplayName: null,
    applicationOutcome: null,
    applicationAttemptId: null,
    applicationEvidenceHash: null,
    applicationEvidenceCode: null,
    providerMessageId: null,
    providerAcceptedObservedAt: null,
    applicationAttemptedAt: null,
    ackReceivedAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    clientVersion: Prisma.prismaVersion.client,
    code: 'P2002',
    meta: { target: ['tenantId', 'source', 'sourceRequestId'] },
  });
}

interface ClientMock {
  humanDecision: { findFirst: jest.Mock; create: jest.Mock };
  tenant: { findUnique: jest.Mock };
}

function makeClient(): ClientMock {
  return {
    humanDecision: { findFirst: jest.fn(), create: jest.fn() },
    tenant: { findUnique: jest.fn() },
  };
}

function makeRepo(
  client: ClientMock,
  options: { inTransaction?: boolean } = {},
) {
  const tenantPrisma = {
    getClient: jest.fn(() => client),
    getTenantId: jest.fn(() => TENANT_ID),
    isInTransaction: jest.fn(() => options.inTransaction ?? false),
    runInTransaction: jest.fn((work: () => Promise<unknown>) => work()),
  };
  const repo = new PrismaRestockIntakeRepository(
    tenantPrisma as unknown as TenantPrismaService,
  );
  return { repo, tenantPrisma };
}

function arrangeCreate(client: ClientMock, record = makeRecord()): void {
  client.humanDecision.findFirst.mockResolvedValue(null);
  client.tenant.findUnique.mockResolvedValue({
    id: TENANT_ID,
    name: BRANCH_NAME,
  });
  client.humanDecision.create.mockResolvedValue(record);
}

describe('PrismaRestockIntakeRepository', () => {
  describe('create', () => {
    it('creates a PENDING v1 decision with a tenant-derived branch snapshot', async () => {
      const client = makeClient();
      const input = baseInput();
      const expectedHash = hashFor(input);
      arrangeCreate(client);
      const { repo } = makeRepo(client);

      const result = await repo.submit(input);

      expect(client.humanDecision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          source: RESTOCK_SOURCE,
          sourceRequestId: SOURCE_REQUEST_ID,
          type: RESTOCK_TYPE,
          canonicalRequestHash: expectedHash,
          submittedCredentialId: 'cred-1',
          branchId: TENANT_ID,
          branchName: BRANCH_NAME,
          productId: PRODUCT_ID,
          productName: 'Cafe de altura',
          variantId: VARIANT_ID,
          sku: 'SKU-1',
          requestedQuantity: 5,
          observedStockAtRequest: 0,
          stockObservedAt: new Date(STOCK_OBSERVED_AT),
          supersedesDecisionId: null,
          status: 'PENDING',
          version: 1,
        }),
      });
      expect(result.status).toBe('created');
      expect(result.request.id).toBe('decision-1');
      expect(result.request.canonicalRequestHash).toBe(expectedHash);
      expect(result.request.status).toBe('PENDING');
      expect(result.request.version).toBe(1);
      expect(result.request.snapshot).toEqual({
        branchId: TENANT_ID,
        branchName: BRANCH_NAME,
        productId: PRODUCT_ID,
        productName: 'Cafe de altura',
        variantId: VARIANT_ID,
        sku: 'SKU-1',
        requestedQuantity: 5,
        observedStockAtRequest: 0,
        stockObservedAt: new Date(STOCK_OBSERVED_AT),
      });
    });

    it('reads the tenant explicitly by the service-derived tenant id', async () => {
      const client = makeClient();
      arrangeCreate(client);
      const { repo } = makeRepo(client);

      await repo.submit(baseInput());

      expect(client.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: TENANT_ID },
        select: { id: true, name: true },
      });
    });

    it('runs the identity read and the insert inside the tenant transaction', async () => {
      const client = makeClient();
      arrangeCreate(client);
      const { repo, tenantPrisma } = makeRepo(client);

      await repo.submit(baseInput());

      expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('runtime trust boundary', () => {
    it('derives the tenant from TenantPrismaService even when the payload carries a tenantId key', async () => {
      const client = makeClient();
      arrangeCreate(client);
      const { repo } = makeRepo(client);

      await repo.submit({
        ...baseInput(),
        tenantId: 'attacker-tenant',
      } as RestockIntakeInput);

      expect(client.humanDecision.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          source: RESTOCK_SOURCE,
          sourceRequestId: SOURCE_REQUEST_ID,
        }),
      });
      expect(client.humanDecision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ tenantId: TENANT_ID }),
      });
    });

    it('fixes source and type server-side even when the payload carries them', async () => {
      const client = makeClient();
      arrangeCreate(client);
      const { repo } = makeRepo(client);

      await repo.submit({
        ...baseInput(),
        source: 'evil-source',
        type: 'SHIPPING',
      } as RestockIntakeInput);

      expect(client.humanDecision.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({ source: RESTOCK_SOURCE }),
      });
      expect(client.humanDecision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          source: RESTOCK_SOURCE,
          type: RESTOCK_TYPE,
        }),
      });
    });

    it('ignores client-supplied branch fields and stores the tenant snapshot', async () => {
      const client = makeClient();
      arrangeCreate(client);
      const { repo } = makeRepo(client);

      await repo.submit({
        ...baseInput(),
        branchId: 'attacker-branch',
        branchName: 'attacker-name',
      } as RestockIntakeInput);

      expect(client.humanDecision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          branchId: TENANT_ID,
          branchName: BRANCH_NAME,
        }),
      });
    });
  });

  describe('idempotent replay', () => {
    it('returns the persisted request with replayed status and does not create a second row', async () => {
      const client = makeClient();
      const input = baseInput();
      client.humanDecision.findFirst.mockResolvedValue(
        makeRecord({ canonicalRequestHash: hashFor(input) }),
      );
      const { repo } = makeRepo(client);

      const result = await repo.submit(input);

      expect(result.status).toBe('replayed');
      expect(result.request.id).toBe('decision-1');
      expect(client.humanDecision.create).not.toHaveBeenCalled();
      expect(client.tenant.findUnique).not.toHaveBeenCalled();
    });

    it('does not overwrite the audit credential on replay after credential rotation', async () => {
      const client = makeClient();
      const original = baseInput({ submittedCredentialId: 'cred-old' });
      const rotated = baseInput({ submittedCredentialId: 'cred-new' });
      client.humanDecision.findFirst.mockResolvedValue(
        makeRecord({ canonicalRequestHash: hashFor(original) }),
      );
      const { repo } = makeRepo(client);

      const result = await repo.submit(rotated);

      expect(result.status).toBe('replayed');
      expect(client.humanDecision.create).not.toHaveBeenCalled();
    });

    it('throws IDEMPOTENCY_CONFLICT when the identity has a different canonical payload', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(
        makeRecord({ canonicalRequestHash: 'different-hash' }),
      );
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(client.humanDecision.create).not.toHaveBeenCalled();
    });

    it('looks up the identity with explicit tenant and source predicates', async () => {
      const client = makeClient();
      arrangeCreate(client);
      const { repo } = makeRepo(client);

      await repo.submit(baseInput());

      expect(client.humanDecision.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT_ID,
          source: RESTOCK_SOURCE,
          sourceRequestId: SOURCE_REQUEST_ID,
        },
      });
    });
  });

  describe('successor predecessor eligibility', () => {
    function arrangeSuccessor(
      client: ClientMock,
      predecessor: Partial<HumanDecisionRecord> | null,
    ): void {
      client.humanDecision.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          predecessor
            ? makeRecord({ id: PREDECESSOR_ID, ...predecessor })
            : null,
        );
      client.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        name: BRANCH_NAME,
      });
      client.humanDecision.create.mockResolvedValue(
        makeRecord({ supersedesDecisionId: PREDECESSOR_ID }),
      );
    }

    it('creates a successor when the predecessor is durably STALE', async () => {
      const client = makeClient();
      arrangeSuccessor(client, { applicationOutcome: 'STALE' });
      const { repo } = makeRepo(client);

      const result = await repo.submit(
        baseInput({ supersedesDecisionId: PREDECESSOR_ID }),
      );

      expect(result.status).toBe('created');
      expect(client.humanDecision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ supersedesDecisionId: PREDECESSOR_ID }),
      });
    });

    it('queries the predecessor with explicit tenant and source predicates', async () => {
      const client = makeClient();
      arrangeSuccessor(client, { applicationOutcome: 'STALE' });
      const { repo } = makeRepo(client);

      await repo.submit(baseInput({ supersedesDecisionId: PREDECESSOR_ID }));

      expect(client.humanDecision.findFirst).toHaveBeenNthCalledWith(2, {
        where: {
          id: PREDECESSOR_ID,
          tenantId: TENANT_ID,
          source: RESTOCK_SOURCE,
        },
      });
    });

    it('throws a sanitized NOT_FOUND for a missing or cross-tenant predecessor', async () => {
      const client = makeClient();
      arrangeSuccessor(client, null);
      const { repo } = makeRepo(client);

      await expect(
        repo.submit(baseInput({ supersedesDecisionId: PREDECESSOR_ID })),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(client.humanDecision.create).not.toHaveBeenCalled();
    });

    it.each<HumanDecisionBotOutcome | null>([
      null,
      'PROVIDER_ACCEPTED',
      'PROVIDER_ACCEPTED_LATE',
      'DELIVERY_UNKNOWN',
    ])(
      'throws VERSION_CONFLICT when the predecessor outcome is %p (never supersedable)',
      async (outcome) => {
        const client = makeClient();
        arrangeSuccessor(client, { applicationOutcome: outcome });
        const { repo } = makeRepo(client);

        await expect(
          repo.submit(baseInput({ supersedesDecisionId: PREDECESSOR_ID })),
        ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
        expect(client.humanDecision.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('unique-constraint races', () => {
    it('recovers an identical-identity create race by re-reading and replaying exactly', async () => {
      const client = makeClient();
      const input = baseInput();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeRecord({ canonicalRequestHash: hashFor(input) }),
        );
      client.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        name: BRANCH_NAME,
      });
      client.humanDecision.create.mockRejectedValue(uniqueViolation());
      const { repo } = makeRepo(client);

      const result = await repo.submit(input);

      expect(result.status).toBe('replayed');
      expect(result.request.id).toBe('decision-1');
    });

    it('returns IDEMPOTENCY_CONFLICT when the race winner has a different hash', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeRecord({ canonicalRequestHash: 'race-hash' }),
        );
      client.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        name: BRANCH_NAME,
      });
      client.humanDecision.create.mockRejectedValue(uniqueViolation());
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
    });

    it('throws VERSION_CONFLICT when a different successor identity collides on the predecessor', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeRecord({ id: PREDECESSOR_ID, applicationOutcome: 'STALE' }),
        )
        .mockResolvedValueOnce(null);
      client.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        name: BRANCH_NAME,
      });
      client.humanDecision.create.mockRejectedValue(uniqueViolation());
      const { repo } = makeRepo(client);

      await expect(
        repo.submit(baseInput({ supersedesDecisionId: PREDECESSOR_ID })),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    });
  });

  describe('top-level transaction precondition', () => {
    it('rejects a nested submit before opening a transaction or running any query', async () => {
      const client = makeClient();
      const { repo, tenantPrisma } = makeRepo(client, { inTransaction: true });

      await expect(repo.submit(baseInput())).rejects.toThrow(
        'must be called outside an ambient transaction',
      );

      expect(tenantPrisma.runInTransaction).not.toHaveBeenCalled();
      expect(tenantPrisma.getClient).not.toHaveBeenCalled();
      expect(tenantPrisma.getTenantId).not.toHaveBeenCalled();
      expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
      expect(client.humanDecision.create).not.toHaveBeenCalled();
      expect(client.tenant.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('error safety', () => {
    it('rethrows unrelated Prisma errors instead of masking them', async () => {
      const client = makeClient();
      const failure = new Prisma.PrismaClientKnownRequestError('FK failed', {
        clientVersion: Prisma.prismaVersion.client,
        code: 'P2003',
      });
      client.humanDecision.findFirst.mockResolvedValue(null);
      client.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        name: BRANCH_NAME,
      });
      client.humanDecision.create.mockRejectedValue(failure);
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toBe(failure);
    });

    it('rethrows generic database failures untouched', async () => {
      const client = makeClient();
      const failure = new Error('connection reset');
      client.humanDecision.findFirst.mockResolvedValue(null);
      client.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        name: BRANCH_NAME,
      });
      client.humanDecision.create.mockRejectedValue(failure);
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toBe(failure);
    });

    it('never echoes confidential payload values in a conflict error', async () => {
      const client = makeClient();
      const productName = 'CUSTOMER-NAME-DO-NOT-LEAK';
      const sku = 'SECRET-SKU';
      const credentialId = 'cred-secret-999';
      const input = baseInput({
        productName,
        sku,
        submittedCredentialId: credentialId,
      });
      client.humanDecision.findFirst.mockResolvedValue(
        makeRecord({ canonicalRequestHash: 'mismatch-hash' }),
      );
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .submit(input)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RestockIntakeError);
      if (!(error instanceof RestockIntakeError)) {
        throw new Error('expected RestockIntakeError');
      }
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(error.message).not.toContain(productName);
      expect(error.message).not.toContain(sku);
      expect(error.message).not.toContain(credentialId);
      expect(error.message).not.toContain(SOURCE_REQUEST_ID);
    });
  });
});
