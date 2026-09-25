/**
 * HD-04c2 — ADAPTER: PrismaHumanDecisionReviewResolveRepository.
 *
 * Concrete `IHumanDecisionReviewResolveRepository` over Prisma. It depends
 * ONLY on `TenantPrismaService` (never the root `PrismaService`), so every
 * query flows through the CLS-driven tenant-scoping extension, and it injects
 * `tenantId` explicitly as defense-in-depth. `getTenantId()` is called
 * UNCONDITIONALLY before the transaction, so a superadmin session without a
 * selected tenant fails closed instead of resolving across tenants.
 *
 * TRANSACTION PRECONDITION: `resolve()` must run at TOP LEVEL, i.e. outside an
 * existing `TenantPrismaService.runInTransaction`. A nested call would reuse
 * the ambient transaction, so the one-winner CAS and its follow-read could
 * commit or roll back with an unrelated caller. The adapter therefore fails
 * closed BEFORE any query when `isInTransaction()` is true. The contract
 * caller (HD-04d controller) is a standalone route, so nested resolve is
 * intentionally unsupported (no savepoints yet).
 *
 * ACTOR VERIFICATION (inside the transaction, before the decision):
 *   1. Load the current `User` by the JWT actor id. A missing, inactive or
 *      blank-display-name user is `UNAUTHORIZED`; the display name is ALWAYS
 *      this persisted `User.name`, never client input.
 *   2. An ordinary reviewer must have an explicit `TenantMembership` for the
 *      CLS tenant, else `FORBIDDEN`. A server-signed superadmin
 *      (`actorIsSuperAdmin`) with a selected tenant bypasses membership but
 *      still requires an active `User`.
 *
 * ACTOR PROVENANCE (HD-04d WIRING BLOCKER, not proven here): this adapter
 * TRUSTS `actorUserId`/`actorIsSuperAdmin` and enforces only the persisted
 * `User`/membership rules above. It does NOT and cannot prove the caller
 * passed verified privilege. The future HD-04d route MUST (a) run the exact
 * pure parser `parseResolveHumanDecisionRequest` on the untrusted body and
 * (b) derive `actorUserId`/`actorIsSuperAdmin` exclusively from the verified
 * JWT/guard — never from the request body. Until that wiring exists this port
 * is NOT a privilege boundary and must not be exposed by any route.
 *
 * ONE-WINNER CAS: the decision is looked up by id + tenant + RESTOCK
 * source/type. A `PENDING` row whose `version` differs from `expectedVersion`
 * is `VERSION_CONFLICT`. Otherwise a single `updateMany` conditioned on
 * `status='PENDING' AND version=expectedVersion` flips it to `RESOLVED`/
 * version 2 with the immutable reviewer snapshots (`resolvedById` FK +
 * `resolvedByActorId`/`resolvedByDisplayName`) and a server `new Date()`.
 * `count === 1` is the winner; `count === 0` re-reads the committed winner and
 * applies the SAME replay/conflict classification as a direct `RESOLVED` read.
 * Any other `count` is an integrity/programmer error: the CAS is scoped by the
 * primary-key `id`, so it can only affect 0 or 1 row, and such a value throws a
 * value-free plain `Error` (rolling the transaction back) instead of a false
 * replay or a fabricated 409.
 *
 * REPLAY/CONFLICT: same `resolutionRequestId` + exact action/days +
 * `expectedVersion=1` + same actor id replays with no mutation; any other
 * payload/actor under the same key is `IDEMPOTENCY_CONFLICT`; a different key
 * is `ALREADY_RESOLVED`. A missing/cross-tenant/foreign-source decision is a
 * sanitized `NOT_FOUND`.
 *
 * MUTATION SCOPE: the only write is the `humanDecision.updateMany` above. This
 * adapter never touches bot outcome, provider, stock, sale or any other model.
 *
 * PROJECTION: the committed read reuses the exported `REVIEW_RECORD_SELECT`
 * from the HD-04b3 read adapter, so the response can never widen into a full
 * Prisma row with bot/PII fields.
 *
 * KNOWN RESIDUAL LIMITS (documented, NOT proven here):
 *   * `resolutionRequestId` uniqueness is PER DECISION. The route
 *     `POST /human-decisions/:id/resolve` includes the decision id, and the
 *     schema has NO cross-decision unique constraint on
 *     `resolutionRequestId`; the same key against two different decisions is
 *     treated as two independent resolutions.
 *   * Actor revocation/change vs commit: the `User` and membership are read
 *     once at transaction start. A revocation that lands after that read is
 *     not re-checked, so a resolution may commit under the actor snapshot
 *     observed at read time.
 *   * No lock claim: the CAS and the pre-read are ordinary committed reads, so
 *     this adapter claims no row lock and no serialization behavior. HD-04c3
 *     owns the real PostgreSQL two-reviewer race (including whether Prisma
 *     reports a serialization `P2034` on the losing transaction).
 *   * Server clock: `resolvedAt` defaults to `new Date()` (or the injected
 *     clock) and is an audit timestamp only, a conservative deadline anchor,
 *     never an authoritative lock/ordering guarantee.
 *
 * DB-FREE PROOF: the companion spec mocks `TenantPrismaService`; it proves the
 * adapter seams, NOT real PostgreSQL row locking or a two-reviewer race.
 * HD-04c3 owns the dedicated local PostgreSQL two-reviewer race proof.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  HumanDecisionReviewResolveError,
  type HumanDecisionReviewResolveErrorCode,
  type HumanDecisionReviewResolveResult,
  type IHumanDecisionReviewResolveRepository,
  type ResolveHumanDecisionCommand,
} from '../domain/human-decision-review-resolve.repository';
import type { HumanDecisionReviewRecord } from '../domain/human-decision-review-read.repository';
import { REVIEW_RECORD_SELECT } from './prisma-human-decision-review-read.repository';

type TenantScopedClient = ReturnType<TenantPrismaService['getClient']>;

/**
 * Internal decision-state projection. It carries ONLY the fields needed to
 * classify the CAS (`status`/`version`) and to compare an idempotent replay
 * (`resolutionRequestId`/`resolutionAction`/`restockDays`/`resolvedByActorId`).
 * It is NEVER returned to the caller.
 */
const DECISION_STATE_SELECT = {
  id: true,
  status: true,
  version: true,
  resolutionRequestId: true,
  resolutionAction: true,
  restockDays: true,
  resolvedByActorId: true,
} satisfies Prisma.HumanDecisionSelect;

type DecisionStateRow = Prisma.HumanDecisionGetPayload<{
  select: typeof DECISION_STATE_SELECT;
}>;

/** Persisted reviewer identity resolved inside the transaction. */
interface ReviewerActor {
  id: string;
  name: string;
}

/**
 * Fixed, value-free messages. Nothing here is derived from the command, so a
 * decision id, resolution request id or actor value can never leak.
 */
const ERROR_MESSAGES: Record<HumanDecisionReviewResolveErrorCode, string> = {
  NOT_FOUND: 'Human decision not found',
  UNAUTHORIZED: 'Reviewer is not an active user',
  FORBIDDEN: 'Reviewer is not authorized for this tenant',
  VERSION_CONFLICT: 'Human decision version conflict',
  IDEMPOTENCY_CONFLICT:
    'Resolution request conflicts with the committed resolution',
  ALREADY_RESOLVED: 'Human decision was already resolved',
};

/** Throw one value-free resolve failure. */
function fail(code: HumanDecisionReviewResolveErrorCode): never {
  throw new HumanDecisionReviewResolveError(code, ERROR_MESSAGES[code]);
}

/**
 * Value-free programmer-context error for a nested `resolve()`. A plain
 * `Error` on purpose: the ambient-transaction misuse is a server bug and must
 * never surface as a replay or a sanitized client conflict.
 */
const NESTED_TRANSACTION_ERROR =
  'PrismaHumanDecisionReviewResolveRepository.resolve must be called outside an ambient transaction';

/**
 * Value-free programmer-context error for an unexpected `updateMany` count.
 * The CAS is scoped by the primary-key `id`, so it can only affect 0 or 1 row;
 * any other value is an integrity/server bug and must roll the transaction back
 * instead of being misclassified as a loser or a 409.
 */
const UNEXPECTED_UPDATE_COUNT_ERROR =
  'PrismaHumanDecisionReviewResolveRepository.resolve observed an unexpected updateMany count';

/** Optional server clock, bound by HD-04d; defaults to `new Date()`. */
export type HumanDecisionReviewResolveClock = () => Date;

/** Injection token for the optional clock; absent => `new Date()`. */
export const HUMAN_DECISION_REVIEW_RESOLVE_CLOCK = Symbol(
  'HUMAN_DECISION_REVIEW_RESOLVE_CLOCK',
);

@Injectable()
export class PrismaHumanDecisionReviewResolveRepository implements IHumanDecisionReviewResolveRepository {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @Optional()
    @Inject(HUMAN_DECISION_REVIEW_RESOLVE_CLOCK)
    private readonly clock?: HumanDecisionReviewResolveClock,
  ) {}

  async resolve(
    command: ResolveHumanDecisionCommand,
  ): Promise<HumanDecisionReviewResolveResult> {
    // Fail closed BEFORE any query/transaction; see the class-level
    // TRANSACTION PRECONDITION. `isInTransaction()` only reads CLS.
    if (this.tenantPrisma.isInTransaction()) {
      throw new Error(NESTED_TRANSACTION_ERROR);
    }

    // Tenant is ALWAYS from the CLS context, never the command, and is
    // resolved unconditionally so a tenantless superadmin fails closed.
    const tenantId = this.tenantPrisma.getTenantId();

    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();

      const actor = await this.loadReviewer(db, command);
      if (!command.actorIsSuperAdmin) {
        await this.assertTenantMembership(db, tenantId, command.actorUserId);
      }

      const current = await this.findDecisionState(
        db,
        tenantId,
        command.decisionId,
      );
      if (current === null) {
        return fail('NOT_FOUND');
      }

      if (current.status === 'RESOLVED') {
        this.assertExactReplay(current, command);
        return {
          status: 'replayed',
          decision: await this.readProjection(db, tenantId, command.decisionId),
        };
      }

      if (current.version !== command.expectedVersion) {
        return fail('VERSION_CONFLICT');
      }

      const updated = await db.humanDecision.updateMany({
        where: {
          id: command.decisionId,
          tenantId,
          source: RESTOCK_SOURCE,
          type: RESTOCK_TYPE,
          status: 'PENDING',
          version: command.expectedVersion,
        },
        data: this.buildResolutionData(command, actor),
      });

      if (updated.count === 1) {
        return {
          status: 'resolved',
          decision: await this.readProjection(db, tenantId, command.decisionId),
        };
      }

      // The CAS is scoped by primary-key `id`, so a trusted updateMany can only
      // affect 0 or 1 row. Any other count is an integrity/programmer error:
      // throw a value-free plain Error so the transaction rolls back and this
      // never becomes a false replay or a fabricated sanitized conflict.
      if (updated.count !== 0) {
        throw new Error(UNEXPECTED_UPDATE_COUNT_ERROR);
      }

      // count === 0: a concurrent reviewer won the CAS. Re-read the committed
      // winner inside this transaction and classify the loser identically to a
      // direct RESOLVED read.
      const winner = await this.findDecisionState(
        db,
        tenantId,
        command.decisionId,
      );
      if (winner === null || winner.status !== 'RESOLVED') {
        return fail('VERSION_CONFLICT');
      }
      this.assertExactReplay(winner, command);
      return {
        status: 'replayed',
        decision: await this.readProjection(db, tenantId, command.decisionId),
      };
    });
  }

  /** Load the persisted reviewer identity; fail closed when unusable. */
  private async loadReviewer(
    db: TenantScopedClient,
    command: ResolveHumanDecisionCommand,
  ): Promise<ReviewerActor> {
    const actor = await db.user.findUnique({
      where: { id: command.actorUserId },
      select: { id: true, name: true, isActive: true },
    });
    if (actor === null || !actor.isActive || actor.name.trim().length === 0) {
      return fail('UNAUTHORIZED');
    }
    return { id: actor.id, name: actor.name };
  }

  /** Explicit tenant membership for an ordinary reviewer. */
  private async assertTenantMembership(
    db: TenantScopedClient,
    tenantId: string,
    actorUserId: string,
  ): Promise<void> {
    const membership = await db.tenantMembership.findFirst({
      where: { userId: actorUserId, tenantId },
      select: { id: true },
    });
    if (membership === null) {
      return fail('FORBIDDEN');
    }
  }

  /** Tenant/source/type-scoped decision state; never a full row. */
  private async findDecisionState(
    db: TenantScopedClient,
    tenantId: string,
    decisionId: string,
  ): Promise<DecisionStateRow | null> {
    return db.humanDecision.findFirst({
      where: {
        id: decisionId,
        tenantId,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
      },
      select: DECISION_STATE_SELECT,
    });
  }

  /**
   * Committed reviewer projection read, reusing the SAME `REVIEW_RECORD_SELECT`
   * allowlist as the HD-04b3 read adapter.
   */
  private async readProjection(
    db: TenantScopedClient,
    tenantId: string,
    decisionId: string,
  ): Promise<HumanDecisionReviewRecord> {
    const record = await db.humanDecision.findFirst({
      where: {
        id: decisionId,
        tenantId,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
      },
      select: REVIEW_RECORD_SELECT,
    });
    if (record === null) {
      return fail('NOT_FOUND');
    }
    return record;
  }

  /**
   * Classify an already-`RESOLVED` decision against the command. Throws
   * `ALREADY_RESOLVED` for a different key and `IDEMPOTENCY_CONFLICT` for the
   * same key with any non-exact payload/actor; returns silently for an exact
   * replay.
   */
  private assertExactReplay(
    decision: DecisionStateRow,
    command: ResolveHumanDecisionCommand,
  ): void {
    if (decision.resolutionRequestId !== command.resolutionRequestId) {
      return fail('ALREADY_RESOLVED');
    }
    const expectedDays =
      command.action === HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE
        ? command.restockDays
        : null;
    const isExactReplay =
      command.expectedVersion === 1 &&
      decision.resolutionAction === command.action &&
      decision.restockDays === expectedDays &&
      decision.resolvedByActorId === command.actorUserId;
    if (!isExactReplay) {
      return fail('IDEMPOTENCY_CONFLICT');
    }
  }

  /** Immutable resolution write payload; server time and server actor only. */
  private buildResolutionData(
    command: ResolveHumanDecisionCommand,
    actor: ReviewerActor,
  ): Prisma.HumanDecisionUncheckedUpdateManyInput {
    return {
      status: 'RESOLVED',
      version: 2,
      resolutionAction: command.action,
      restockDays:
        command.action === HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE
          ? command.restockDays
          : null,
      resolutionRequestId: command.resolutionRequestId,
      resolvedAt: this.now(),
      resolvedById: actor.id,
      resolvedByActorId: actor.id,
      resolvedByDisplayName: actor.name,
    };
  }

  /** Server clock; `new Date()` unless HD-04d binds a clock. */
  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }
}
