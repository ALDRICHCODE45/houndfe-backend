/**
 * HD-02b1 — ADAPTER: PrismaRestockIntakeRepository.
 *
 * Concrete `IRestockIntakeRepository` over Prisma. Tenant scoping is
 * delegated to `TenantPrismaService` (the CLS-driven WHERE injection backed by
 * the `HumanDecision` allowlist entry) and repeated explicitly here as
 * defense-in-depth: every read carries `tenantId` + `source`, and the insert
 * carries both explicitly even inside an ambient transaction.
 *
 * Idempotency: the identity `(tenantId, source, sourceRequestId)` is read
 * before insert; a matching canonical hash replays the SAME persisted row with
 * `status: 'replayed'` and touches NO audit column, so credential rotation
 * cannot rewrite `submittedCredentialId`. A different hash is
 * `IDEMPOTENCY_CONFLICT`. Prisma `upsert` is deliberately NOT used: its
 * `update` branch could rewrite credential/hash on replay.
 *
 * Supersession: the predecessor is looked up by id + tenant + source inside
 * the same transaction. Missing/foreign -> sanitized `NOT_FOUND`; anything
 * other than a durable `STALE` outcome (including `null`, `DELIVERY_UNKNOWN`
 * and `PROVIDER_ACCEPTED_LATE`) -> sanitized `VERSION_CONFLICT`. v1 has no
 * audited reconciliation state, so only `STALE` is ever eligible.
 *
 * Races: the DB unique constraints are the real guard. A `P2002` aborts the
 * transaction and is handled OUTSIDE it: the identity is re-read, and an exact
 * replay/conflict is returned by hash. If no identity row exists, the
 * collision was on `(tenantId, source, supersedesDecisionId)` — a second
 * successor for one predecessor — and maps to `VERSION_CONFLICT`. Any other
 * Prisma error is rethrown untouched.
 *
 * TRANSACTION PRECONDITION: `submit()` must run at TOP LEVEL, i.e. outside an
 * existing `TenantPrismaService.runInTransaction`. A nested call would reuse
 * the ambient transaction; if the insert then raised `P2002`, that ambient
 * PostgreSQL transaction is already aborted, so the recovery `findFirst` would
 * run on the aborted transaction (SQLSTATE 25P02) instead of returning a clean
 * replay/conflict. The adapter therefore fails closed before any query when
 * `isInTransaction()` is true. The current contract caller is a standalone bot
 * route, so nested intake is intentionally unsupported (no savepoints yet).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  canonicalizeRestockRequest,
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  RestockIntakeError,
  type IRestockIntakeRepository,
  type PersistedRestockDecision,
  type RestockIntakeInput,
  type RestockIntakeResult,
} from '../domain/restock-intake.repository';

type HumanDecisionRecord = Prisma.HumanDecisionGetPayload<true>;
type TenantScopedClient = ReturnType<TenantPrismaService['getClient']>;

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Value-free programmer-context error for a nested `submit()`. Deliberately a
 * plain `Error` (not a `RestockIntakeError`): the ambient-transaction misuse
 * is a server bug, so it must never surface as a false replay or a sanitized
 * client conflict.
 */
const NESTED_TRANSACTION_ERROR =
  'PrismaRestockIntakeRepository.submit must be called outside an ambient transaction';

/** Map a persisted row to the sanitized, DTO-ready projection. */
function toPersistedDecision(
  record: HumanDecisionRecord,
): PersistedRestockDecision {
  return {
    id: record.id,
    source: RESTOCK_SOURCE,
    sourceRequestId: record.sourceRequestId,
    type: RESTOCK_TYPE,
    canonicalRequestHash: record.canonicalRequestHash,
    status: record.status,
    version: record.version,
    supersedesDecisionId: record.supersedesDecisionId,
    createdAt: record.createdAt,
    snapshot: {
      branchId: record.branchId,
      branchName: record.branchName,
      productId: record.productId,
      productName: record.productName,
      variantId: record.variantId,
      sku: record.sku,
      requestedQuantity: record.requestedQuantity,
      observedStockAtRequest: record.observedStockAtRequest,
      stockObservedAt: record.stockObservedAt,
    },
  };
}

@Injectable()
export class PrismaRestockIntakeRepository implements IRestockIntakeRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async submit(input: RestockIntakeInput): Promise<RestockIntakeResult> {
    // Fail closed BEFORE any query/transaction; see the class-level
    // TRANSACTION PRECONDITION. `isInTransaction()` only reads CLS.
    if (this.tenantPrisma.isInTransaction()) {
      throw new Error(NESTED_TRANSACTION_ERROR);
    }

    // Tenant is NEVER read from the payload: `tenantId` is placed last so a
    // malicious runtime `tenantId` key is overwritten by the CLS value. The
    // canonicalizer ignores `source`/`type`/branch keys and derives the fixed
    // server constants.
    const tenantId = this.tenantPrisma.getTenantId();
    const { request, requestHash } = canonicalizeRestockRequest({
      ...input,
      tenantId,
    });

    try {
      return await this.tenantPrisma.runInTransaction(async () => {
        const db = this.tenantPrisma.getClient();

        const existing = await db.humanDecision.findFirst({
          where: {
            tenantId,
            source: RESTOCK_SOURCE,
            sourceRequestId: request.sourceRequestId,
          },
        });
        if (existing) {
          return this.resolveIdentity(existing, requestHash);
        }

        if (request.supersedesDecisionId) {
          await this.assertPredecessorEligible(
            db,
            tenantId,
            request.supersedesDecisionId,
          );
        }

        const tenant = await db.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true, name: true },
        });
        if (!tenant) {
          throw new RestockIntakeError('NOT_FOUND', 'Tenant not found');
        }

        const created = await db.humanDecision.create({
          data: {
            tenantId,
            source: RESTOCK_SOURCE,
            sourceRequestId: request.sourceRequestId,
            type: RESTOCK_TYPE,
            canonicalRequestHash: requestHash,
            submittedCredentialId: request.submittedCredentialId,
            // Server-derived branch snapshot; the bot never supplies these.
            branchId: tenant.id,
            branchName: tenant.name,
            productId: request.productId,
            productName: request.productName,
            variantId: request.variantId,
            sku: request.sku,
            requestedQuantity: request.requestedQuantity,
            observedStockAtRequest: request.observedStockAtRequest,
            stockObservedAt:
              request.stockObservedAt === null
                ? null
                : new Date(request.stockObservedAt),
            supersedesDecisionId: request.supersedesDecisionId,
            status: 'PENDING',
            version: 1,
          },
        });

        return { status: 'created', request: toPersistedDecision(created) };
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        // The insert raced a concurrent writer and the transaction is already
        // aborted; recover against the committed winner outside it.
        return this.recoverFromUniqueRace(
          tenantId,
          request.sourceRequestId,
          requestHash,
        );
      }
      throw error;
    }
  }

  /** Exact replay on hash match; value-free conflict otherwise. */
  private resolveIdentity(
    existing: HumanDecisionRecord,
    requestHash: string,
  ): RestockIntakeResult {
    if (existing.canonicalRequestHash === requestHash) {
      return { status: 'replayed', request: toPersistedDecision(existing) };
    }
    throw new RestockIntakeError(
      'IDEMPOTENCY_CONFLICT',
      'A different RESTOCK payload was already submitted for this idempotency key',
    );
  }

  private async assertPredecessorEligible(
    db: TenantScopedClient,
    tenantId: string,
    supersedesDecisionId: string,
  ): Promise<void> {
    // Explicit tenant/source predicates keep a cross-tenant or foreign-source
    // predecessor indistinguishable from a missing one.
    const predecessor = await db.humanDecision.findFirst({
      where: {
        id: supersedesDecisionId,
        tenantId,
        source: RESTOCK_SOURCE,
      },
    });
    if (!predecessor) {
      throw new RestockIntakeError(
        'NOT_FOUND',
        'Referenced decision not found',
      );
    }
    // Only a durable STALE outcome is supersedable in v1. `null` (still
    // pending), `DELIVERY_UNKNOWN` and `PROVIDER_ACCEPTED_LATE` are holds,
    // never reconciliation.
    if (predecessor.applicationOutcome !== 'STALE') {
      throw new RestockIntakeError(
        'VERSION_CONFLICT',
        'Referenced decision is not eligible for supersession',
      );
    }
  }

  private async recoverFromUniqueRace(
    tenantId: string,
    sourceRequestId: string,
    requestHash: string,
  ): Promise<RestockIntakeResult> {
    const db = this.tenantPrisma.getClient();
    const raced = await db.humanDecision.findFirst({
      where: { tenantId, source: RESTOCK_SOURCE, sourceRequestId },
    });
    if (raced) {
      return this.resolveIdentity(raced, requestHash);
    }
    // No identity row: the collision was the one-successor-per-predecessor
    // unique constraint, so another successor already won this predecessor.
    throw new RestockIntakeError(
      'VERSION_CONFLICT',
      'A successor request already exists for the referenced decision',
    );
  }
}
