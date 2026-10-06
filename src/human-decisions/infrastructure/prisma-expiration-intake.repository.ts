/**
 * HD-EXP-02 — ADAPTER: PrismaExpirationIntakeRepository (UNWIRED).
 *
 * Tenant scoping is delegated to `TenantPrismaService` and repeated explicitly
 * (including the nested variant predicate). Replay runs BEFORE catalog
 * validation, so a rename/unpublish cannot alter an exact replay or its
 * historical snapshot; product lookup is 404-first, a variantId/hasVariants
 * mismatch is 400, a missing owned/non-OFF variant is 404, and a matching
 * EXPIRATION hash replays without touching audit (`upsert` avoided); a
 * different hash or type is 409. `P2002` is recovered OUTSIDE the aborted
 * transaction by re-reading the winner (no winner: rethrow) and `submit()`
 * fails closed inside an ambient transaction. The internal projection fails
 * closed on a null unit or variant metadata inconsistent with `variantId`; the
 * out-of-scope DTO must render it as the immutable `PENDING`/v1 receipt.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  hashExpirationIntakeIdentity,
  type ExpirationIntakeIdentity,
  EXPIRATION_TYPE,
} from '../domain/expiration-intake.request';
import {
  EXPIRATION_SOURCE,
  ExpirationIntakeError,
  type ExpirationIntakeInput,
  type ExpirationIntakeResult,
  type ExpirationIntakeSnapshot,
  type IExpirationIntakeRepository,
  type PersistedExpirationDecision,
} from '../domain/expiration-intake.repository';

type HumanDecisionRecord = Prisma.HumanDecisionGetPayload<true>;
type TenantScopedClient = ReturnType<TenantPrismaService['getClient']>;
type CatalogSnapshot = Omit<
  ExpirationIntakeSnapshot,
  'branchId' | 'branchName'
>;

const NESTED_TRANSACTION_ERROR =
  'PrismaExpirationIntakeRepository.submit must be called outside an ambient transaction';

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Map a persisted row to the sanitized, DTO-ready projection. EXPIRATION rows
 * always persist a non-null unit and variant metadata consistent with
 * `variantId`, so a corrupt row fails closed (server error) instead of leaking
 * a partial or mismatched snapshot. Input is already the trusted parser output,
 * so it is never re-parsed here.
 */
function toPersistedDecision(
  record: HumanDecisionRecord,
): PersistedExpirationDecision {
  const { productUnit, variantId, variantName, variantOption, variantValue } =
    record;
  if (productUnit === null) {
    throw new Error('Persisted EXPIRATION decision has no product unit');
  }
  if (variantId !== null && variantName === null) {
    throw new Error('Persisted EXPIRATION variant has no name');
  }
  if (
    variantId === null &&
    (variantName !== null || variantOption !== null || variantValue !== null)
  ) {
    throw new Error(
      'Persisted EXPIRATION simple snapshot carries variant metadata',
    );
  }
  return {
    id: record.id,
    source: EXPIRATION_SOURCE,
    sourceRequestId: record.sourceRequestId,
    type: EXPIRATION_TYPE,
    canonicalRequestHash: record.canonicalRequestHash,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    snapshot: {
      branchId: record.branchId,
      branchName: record.branchName,
      productId: record.productId,
      productName: record.productName,
      productUnit,
      variantId,
      variantName,
      variantOption,
      variantValue,
    },
  };
}

@Injectable()
export class PrismaExpirationIntakeRepository implements IExpirationIntakeRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async submit(input: ExpirationIntakeInput): Promise<ExpirationIntakeResult> {
    if (this.tenantPrisma.isInTransaction()) {
      throw new Error(NESTED_TRANSACTION_ERROR);
    }
    // Tenant is NEVER read from the payload; the input is already the trusted
    // parser output and `type` is fixed server-side.
    const tenantId = this.tenantPrisma.getTenantId();
    const identity: ExpirationIntakeIdentity = {
      sourceRequestId: input.sourceRequestId,
      type: EXPIRATION_TYPE,
      productId: input.productId,
      variantId: input.variantId,
    };
    const requestHash = hashExpirationIntakeIdentity(identity);

    try {
      return await this.tenantPrisma.runInTransaction(async () => {
        const db = this.tenantPrisma.getClient();
        const existing = await db.humanDecision.findFirst({
          where: {
            tenantId,
            source: EXPIRATION_SOURCE,
            sourceRequestId: identity.sourceRequestId,
          },
        });
        if (existing) {
          return this.resolveIdentity(existing, requestHash);
        }

        const snapshot = await this.resolveCatalogSnapshot(
          db,
          tenantId,
          identity,
        );
        const tenant = await db.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true, name: true },
        });
        if (!tenant) {
          throw new ExpirationIntakeError('NOT_FOUND', 'Tenant not found');
        }

        const created = await db.humanDecision.create({
          data: {
            tenantId,
            source: EXPIRATION_SOURCE,
            sourceRequestId: identity.sourceRequestId,
            type: EXPIRATION_TYPE,
            canonicalRequestHash: requestHash,
            submittedCredentialId: input.submittedCredentialId,
            branchId: tenant.id,
            branchName: tenant.name,
            ...snapshot,
            status: 'PENDING',
            version: 1,
          },
        });
        return { status: 'created', request: toPersistedDecision(created) };
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      const winner = await this.tenantPrisma
        .getClient()
        .humanDecision.findFirst({
          where: {
            tenantId,
            source: EXPIRATION_SOURCE,
            sourceRequestId: identity.sourceRequestId,
          },
        });
      if (!winner) {
        throw error;
      }
      return this.resolveIdentity(winner, requestHash);
    }
  }

  /** 404 for a foreign/missing/unpublished product, 400 for a
   * variantId/`hasVariants` mismatch, then 404 for a missing owned, non-OFF
   * variant. The nested predicate repeats `tenantId` as defense-in-depth. */
  private async resolveCatalogSnapshot(
    db: TenantScopedClient,
    tenantId: string,
    identity: ExpirationIntakeIdentity,
  ): Promise<CatalogSnapshot> {
    const product = await db.product.findFirst({
      where: {
        id: identity.productId,
        tenantId,
        includeInOnlineCatalog: true,
        type: 'PRODUCT',
        AND: [
          {
            OR: [
              { hasVariants: false },
              {
                variants: {
                  some: { tenantId, catalogPublishMode: { not: 'OFF' } },
                },
              },
            ],
          },
        ],
      },
      select: { id: true, name: true, unit: true, hasVariants: true },
    });
    if (!product) {
      throw new ExpirationIntakeError('NOT_FOUND', 'Catalog product not found');
    }
    if (identity.variantId === null && product.hasVariants) {
      throw new ExpirationIntakeError(
        'VALIDATION_ERROR',
        'A variant is required for this product',
      );
    }
    if (identity.variantId !== null && !product.hasVariants) {
      throw new ExpirationIntakeError(
        'VALIDATION_ERROR',
        'A variant is not allowed for this product',
      );
    }

    const base: CatalogSnapshot = {
      productId: product.id,
      productName: product.name,
      productUnit: product.unit,
      variantId: null,
      variantName: null,
      variantOption: null,
      variantValue: null,
    };
    if (identity.variantId === null) {
      return base;
    }

    const variant = await db.variant.findFirst({
      where: {
        id: identity.variantId,
        productId: product.id,
        tenantId,
        catalogPublishMode: { not: 'OFF' },
      },
      select: { id: true, name: true, option: true, value: true },
    });
    if (!variant) {
      throw new ExpirationIntakeError('NOT_FOUND', 'Catalog variant not found');
    }
    return {
      ...base,
      variantId: variant.id,
      variantName: variant.name,
      variantOption: variant.option,
      variantValue: variant.value,
    };
  }

  /** Exact replay on type + hash match; value-free conflict otherwise. */
  private resolveIdentity(
    existing: HumanDecisionRecord,
    requestHash: string,
  ): ExpirationIntakeResult {
    if (
      existing.type === EXPIRATION_TYPE &&
      existing.canonicalRequestHash === requestHash
    ) {
      return { status: 'replayed', request: toPersistedDecision(existing) };
    }
    throw new ExpirationIntakeError(
      'IDEMPOTENCY_CONFLICT',
      'A different request was already submitted for this idempotency key',
    );
  }
}
