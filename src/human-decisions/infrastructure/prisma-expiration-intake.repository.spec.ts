/**
 * HD-EXP-02 — PrismaExpirationIntakeRepository DB-free behavior spec.
 *
 * Mocks `TenantPrismaService` so no PostgreSQL roundtrip happens. Proves the
 * adapter seams: replay-before-catalog (the historical snapshot survives a
 * rename/unpublish), the bot catalog gates and tenant-derived predicates, the
 * variantId/hasVariants 400 vs product 404 precedence, immutable snapshots and
 * audit credential, cross-type/hash 409, `P2002` recovery outside the aborted
 * transaction, the ambient precondition, projection fail-closed invariants and
 * error safety. Real PostgreSQL uniqueness/isolation is NOT proven here.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest asymmetric
   matchers are `any`; the assertions below still pin the exact persisted shape. */
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  EXPIRATION_TYPE,
  hashExpirationIntakeIdentity,
} from '../domain/expiration-intake.request';
import {
  EXPIRATION_SOURCE,
  ExpirationIntakeError,
  type ExpirationIntakeInput,
} from '../domain/expiration-intake.repository';
import { PrismaExpirationIntakeRepository } from './prisma-expiration-intake.repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const SOURCE_REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const PRODUCT_ID = '33333333-3333-4333-8333-333333333333';
const VARIANT_ID = '44444444-4444-4444-8444-444444444444';
const BRANCH_NAME = 'Sucursal Centro';
const PRODUCT_NAME = 'Cafe de altura';
const VARIANT_NAME = '500 g';

const BOT_PRODUCT_WHERE = {
  id: PRODUCT_ID,
  tenantId: TENANT_ID,
  includeInOnlineCatalog: true,
  type: 'PRODUCT',
  AND: [
    {
      OR: [
        { hasVariants: false },
        {
          variants: {
            some: { tenantId: TENANT_ID, catalogPublishMode: { not: 'OFF' } },
          },
        },
      ],
    },
  ],
};

function baseInput(
  overrides: Partial<ExpirationIntakeInput> = {},
): ExpirationIntakeInput {
  return {
    sourceRequestId: SOURCE_REQUEST_ID,
    type: EXPIRATION_TYPE,
    productId: PRODUCT_ID,
    variantId: VARIANT_ID,
    submittedCredentialId: 'cred-1',
    ...overrides,
  };
}

function hashFor(input: ExpirationIntakeInput = baseInput()): string {
  return hashExpirationIntakeIdentity({
    sourceRequestId: input.sourceRequestId,
    type: EXPIRATION_TYPE,
    productId: input.productId,
    variantId: input.variantId,
  });
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'decision-1',
    tenantId: TENANT_ID,
    source: EXPIRATION_SOURCE,
    sourceRequestId: SOURCE_REQUEST_ID,
    type: EXPIRATION_TYPE,
    canonicalRequestHash: hashFor(),
    submittedCredentialId: 'cred-1',
    branchId: TENANT_ID,
    branchName: BRANCH_NAME,
    productId: PRODUCT_ID,
    productName: PRODUCT_NAME,
    productUnit: 'UNIDAD',
    variantId: VARIANT_ID,
    variantName: VARIANT_NAME,
    variantOption: 'Peso',
    variantValue: '500 g',
    status: 'PENDING',
    version: 1,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeClient() {
  return {
    humanDecision: { findFirst: jest.fn(), create: jest.fn() },
    product: { findFirst: jest.fn() },
    variant: { findFirst: jest.fn() },
    tenant: { findUnique: jest.fn() },
  };
}
type Client = ReturnType<typeof makeClient>;

function makeRepo(client: Client, options: { inTransaction?: boolean } = {}) {
  const tenantPrisma = {
    getClient: jest.fn(() => client),
    getTenantId: jest.fn(() => TENANT_ID),
    isInTransaction: jest.fn(() => options.inTransaction ?? false),
    runInTransaction: jest.fn((work: () => Promise<unknown>) => work()),
  };
  return {
    repo: new PrismaExpirationIntakeRepository(
      tenantPrisma as unknown as TenantPrismaService,
    ),
    tenantPrisma,
  };
}

function arrangeCreate(
  client: Client,
  product: Record<string, unknown> = {},
  record = makeRecord(),
): void {
  client.humanDecision.findFirst.mockResolvedValue(null);
  client.product.findFirst.mockResolvedValue({
    id: PRODUCT_ID,
    name: PRODUCT_NAME,
    unit: 'UNIDAD',
    hasVariants: true,
    ...product,
  });
  client.variant.findFirst.mockResolvedValue({
    id: VARIANT_ID,
    name: VARIANT_NAME,
    option: 'Peso',
    value: '500 g',
  });
  client.tenant.findUnique.mockResolvedValue({
    id: TENANT_ID,
    name: BRANCH_NAME,
  });
  client.humanDecision.create.mockResolvedValue(record);
}

function arrangeRace(client: Client): void {
  arrangeCreate(client);
  client.humanDecision.create.mockRejectedValue(uniqueViolation());
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    clientVersion: Prisma.prismaVersion.client,
    code: 'P2002',
    meta: { target: ['tenantId', 'source', 'sourceRequestId'] },
  });
}

describe('PrismaExpirationIntakeRepository', () => {
  describe('create', () => {
    it('creates a PENDING v1 EXPIRATION with the tenant branch and catalog snapshot', async () => {
      const client = makeClient();
      const input = baseInput();
      arrangeCreate(client);
      const { repo, tenantPrisma } = makeRepo(client);

      const result = await repo.submit(input);

      expect(client.humanDecision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          source: EXPIRATION_SOURCE,
          sourceRequestId: SOURCE_REQUEST_ID,
          type: EXPIRATION_TYPE,
          canonicalRequestHash: hashFor(input),
          submittedCredentialId: 'cred-1',
          branchId: TENANT_ID,
          branchName: BRANCH_NAME,
          productId: PRODUCT_ID,
          productName: PRODUCT_NAME,
          productUnit: 'UNIDAD',
          variantId: VARIANT_ID,
          variantName: VARIANT_NAME,
          variantOption: 'Peso',
          variantValue: '500 g',
          status: 'PENDING',
          version: 1,
        }),
      });
      expect(result.status).toBe('created');
      expect(result.request).toMatchObject({
        id: 'decision-1',
        type: EXPIRATION_TYPE,
        status: 'PENDING',
        version: 1,
        snapshot: {
          branchName: BRANCH_NAME,
          productName: PRODUCT_NAME,
          productUnit: 'UNIDAD',
          variantName: VARIANT_NAME,
        },
      });
      expect(client.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: TENANT_ID },
        select: { id: true, name: true },
      });
      expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('bot catalog gates', () => {
    it('looks up the product with the exact bot eligibility predicate', async () => {
      const client = makeClient();
      arrangeCreate(client);
      const { repo } = makeRepo(client);

      await repo.submit(baseInput());

      expect(client.product.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: BOT_PRODUCT_WHERE }),
      );
    });

    it('looks up the variant by owned, tenant-visible predicates', async () => {
      const client = makeClient();
      arrangeCreate(client);
      const { repo } = makeRepo(client);

      await repo.submit(baseInput());

      expect(client.variant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: VARIANT_ID,
            productId: PRODUCT_ID,
            tenantId: TENANT_ID,
            catalogPublishMode: { not: 'OFF' },
          },
        }),
      );
    });

    it('nulls the variant block and skips the variant lookup for a simple product', async () => {
      const client = makeClient();
      const record = makeRecord({
        variantId: null,
        variantName: null,
        variantOption: null,
        variantValue: null,
      });
      arrangeCreate(client, { hasVariants: false }, record);
      const { repo } = makeRepo(client);

      const result = await repo.submit(baseInput({ variantId: null }));

      expect(client.variant.findFirst).not.toHaveBeenCalled();
      expect(result.request.snapshot).toMatchObject({
        productUnit: 'UNIDAD',
        variantId: null,
        variantName: null,
        variantOption: null,
        variantValue: null,
      });
    });

    it('returns NOT_FOUND for a missing product before any variant lookup', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(null);
      client.product.findFirst.mockResolvedValue(null);
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(client.variant.findFirst).not.toHaveBeenCalled();
      expect(client.humanDecision.create).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, unknown>, Partial<ExpirationIntakeInput>]>([
      ['a variant product with no variantId', {}, { variantId: null }],
      ['a simple product with a variantId', { hasVariants: false }, {}],
    ])('returns VALIDATION_ERROR for %s', async (_label, product, input) => {
      const client = makeClient();
      arrangeCreate(client, product);
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput(input))).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(client.variant.findFirst).not.toHaveBeenCalled();
    });

    it('returns NOT_FOUND when the product has no owned, visible variant', async () => {
      const client = makeClient();
      arrangeCreate(client);
      client.variant.findFirst.mockResolvedValue(null);
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(client.humanDecision.create).not.toHaveBeenCalled();
    });
  });

  describe('runtime trust boundary', () => {
    it('derives the tenant from CLS even when the payload carries a tenantId', async () => {
      const client = makeClient();
      arrangeCreate(client);
      const { repo } = makeRepo(client);

      await repo.submit({
        ...baseInput(),
        tenantId: 'attacker-tenant',
      } as ExpirationIntakeInput);

      expect(client.humanDecision.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          source: EXPIRATION_SOURCE,
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
        type: 'RESTOCK',
      } as unknown as ExpirationIntakeInput);

      expect(client.humanDecision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          source: EXPIRATION_SOURCE,
          type: EXPIRATION_TYPE,
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
      } as ExpirationIntakeInput);

      expect(client.humanDecision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          branchId: TENANT_ID,
          branchName: BRANCH_NAME,
        }),
      });
    });
  });

  describe('idempotent replay', () => {
    it('replays the persisted historical snapshot without any catalog read or write', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(
        makeRecord({
          productName: 'OLD LABEL',
          productUnit: 'CAJA',
          variantName: 'OLD VARIANT',
        }),
      );
      client.product.findFirst.mockResolvedValue(null);
      const { repo } = makeRepo(client);

      const result = await repo.submit(baseInput());

      expect(result.status).toBe('replayed');
      expect(result.request.snapshot).toMatchObject({
        productName: 'OLD LABEL',
        productUnit: 'CAJA',
        variantName: 'OLD VARIANT',
      });
      expect(client.humanDecision.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT_ID,
          source: EXPIRATION_SOURCE,
          sourceRequestId: SOURCE_REQUEST_ID,
        },
      });
      expect(client.product.findFirst).not.toHaveBeenCalled();
      expect(client.variant.findFirst).not.toHaveBeenCalled();
      expect(client.tenant.findUnique).not.toHaveBeenCalled();
      expect(client.humanDecision.create).not.toHaveBeenCalled();
    });

    it('does not overwrite the audit credential on replay after rotation', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(makeRecord());
      const { repo } = makeRepo(client);

      const result = await repo.submit(
        baseInput({ submittedCredentialId: 'cred-new' }),
      );

      expect(result.status).toBe('replayed');
      expect(client.humanDecision.create).not.toHaveBeenCalled();
    });

    it('throws IDEMPOTENCY_CONFLICT when the identity has a different hash', async () => {
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

    it('throws IDEMPOTENCY_CONFLICT when the key is held by a RESTOCK row', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(
        makeRecord({ type: 'RESTOCK', canonicalRequestHash: hashFor() }),
      );
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
    });
  });

  describe('unique-constraint races', () => {
    it('recovers an identical-identity race by replaying exactly outside the aborted transaction', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeRecord());
      arrangeRace(client);
      const { repo, tenantPrisma } = makeRepo(client);

      const result = await repo.submit(baseInput());

      expect(result.status).toBe('replayed');
      expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(2);
      expect(tenantPrisma.getClient).toHaveBeenCalledTimes(2);
      expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    });

    it.each<[string, Record<string, unknown>]>([
      ['a different hash', { canonicalRequestHash: 'race-hash' }],
      ['a RESTOCK row', { type: 'RESTOCK', canonicalRequestHash: hashFor() }],
    ])(
      'throws IDEMPOTENCY_CONFLICT when the race winner has %s',
      async (_label, winner) => {
        const client = makeClient();
        client.humanDecision.findFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(makeRecord(winner));
        arrangeRace(client);
        const { repo } = makeRepo(client);

        await expect(repo.submit(baseInput())).rejects.toMatchObject({
          code: 'IDEMPOTENCY_CONFLICT',
        });
      },
    );

    it('rethrows the original P2002 when no identity winner exists after the abort', async () => {
      const client = makeClient();
      const failure = uniqueViolation();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      arrangeRace(client);
      client.humanDecision.create.mockRejectedValue(failure);
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toBe(failure);
      expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe('top-level transaction precondition', () => {
    it('rejects a nested submit before any query or transaction', async () => {
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
      expect(client.product.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('projection invariants', () => {
    it('fails closed when a persisted EXPIRATION variant has no name', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(
        makeRecord({ variantName: null }),
      );
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toThrow(
        'Persisted EXPIRATION variant has no name',
      );
    });

    it('fails closed when a simple snapshot leaks variant metadata', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(
        makeRecord({ variantId: null }),
      );
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toThrow(
        'Persisted EXPIRATION simple snapshot carries variant metadata',
      );
    });

    it('fails closed when a persisted EXPIRATION row has no product unit', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValue(
        makeRecord({ productUnit: null }),
      );
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toThrow(
        'Persisted EXPIRATION decision has no product unit',
      );
    });
  });

  describe('error safety', () => {
    it('rethrows unrelated Prisma errors instead of masking them', async () => {
      const client = makeClient();
      const failure = new Prisma.PrismaClientKnownRequestError('FK failed', {
        clientVersion: Prisma.prismaVersion.client,
        code: 'P2003',
      });
      arrangeCreate(client);
      client.humanDecision.create.mockRejectedValue(failure);
      const { repo } = makeRepo(client);

      await expect(repo.submit(baseInput())).rejects.toBe(failure);
    });

    it('never echoes confidential payload values in a conflict error', async () => {
      const client = makeClient();
      const credentialId = 'cred-secret-999';
      client.humanDecision.findFirst.mockResolvedValue(
        makeRecord({ canonicalRequestHash: 'mismatch-hash' }),
      );
      const { repo } = makeRepo(client);

      const error: unknown = await repo
        .submit(baseInput({ submittedCredentialId: credentialId }))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ExpirationIntakeError);
      if (!(error instanceof ExpirationIntakeError)) {
        throw new Error('expected ExpirationIntakeError');
      }
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(error.message).not.toContain(credentialId);
      expect(error.message).not.toContain(SOURCE_REQUEST_ID);
      expect(error.message).not.toContain(PRODUCT_NAME);
    });
  });
});
