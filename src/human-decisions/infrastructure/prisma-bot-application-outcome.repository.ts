/**
 * HD-05b2 — ADAPTER: PrismaBotApplicationOutcomeRepository.
 *
 * Concrete `IBotApplicationOutcomeRepository` over Prisma. It depends ONLY on
 * `TenantPrismaService` (never the root `PrismaService`), so every query flows
 * through the CLS-driven tenant-scoping extension, and it injects `tenantId`
 * explicitly as defense-in-depth. `getTenantId()` is called UNCONDITIONALLY
 * before the transaction, so a superadmin session without a selected tenant
 * fails closed instead of ACKing across tenants.
 *
 * TRANSACTION PRECONDITION: `record()` must run at TOP LEVEL, i.e. outside an
 * existing `TenantPrismaService.runInTransaction`. A nested call would reuse
 * the ambient transaction, so the one-terminal CAS, its follow-read and the
 * commit semantics could no longer be attributed to this request. The adapter
 * therefore fails closed BEFORE any query when `isInTransaction()` is true.
 *
 * DEFENSIVE INPUT: the command carries the EXACT parsed
 * `BotApplicationOutcomeRequest`, but a static type is not a runtime guarantee,
 * so the adapter re-runs `parseBotApplicationOutcomeRequest` and derives the
 * idempotency identity through `hashBotApplicationOutcomeEvidence` — both
 * re-validate and fail closed value-free. A client-supplied hash can never be
 * read. `tenantId`, `source`, `type` and `ackReceivedAt` come from the
 * server/CLS, never from the command.
 *
 * ONE-TERMINAL CAS: the decision is looked up by id + tenant + shared source
 * with a CLOSED type admission of RESTOCK/EXPIRATION (never `findUnique` by id
 * alone, and an unknown/foreign type is a sanitized `NOT_FOUND`). A missing/
 * foreign row is a sanitized `NOT_FOUND`; a non-`RESOLVED` row, a non-2
 * `expectedResolutionVersion` or a persisted `version` other than the expected
 * 2 is `VERSION_CONFLICT`. With no terminal present, the bot-observed
 * `attemptedAt` must fall inside the type-aware half-open
 * `[resolvedAt, resolvedAt + window)` window (1h for RESTOCK, 24h for
 * EXPIRATION), `PROVIDER_ACCEPTED` must be observed strictly before the
 * deadline and `PROVIDER_ACCEPTED_LATE` at/after it (an out-of-contract window
 * is a fixed value-free `InvalidArgumentError`, mapping to `400`). A single
 * `updateMany` conditioned on `status='RESOLVED' AND version=2 AND
 * applicationOutcome IS NULL` then writes
 * the terminal outcome. `count === 1` re-reads and returns the committed row;
 * `count === 0` re-reads the winner and classifies it. Any other count is an
 * integrity/programmer error and throws a value-free plain `Error`.
 *
 * IDEMPOTENT REPLAY: a persisted terminal with the SAME attempt id + canonical
 * hash replays the committed acknowledgment with NO mutation, preserving the
 * persisted `ackReceivedAt` and NEVER re-validating the time window (stable
 * after the deadline). The same attempt id with a different hash is
 * `IDEMPOTENCY_CONFLICT`; any other attempt id is `OUTCOME_ALREADY_RECORDED`
 * (including the UNKNOWN/LATE reconciliation hold).
 *
 * MUTATION SCOPE: the only write is the `humanDecision.updateMany` above. The
 * adapter NEVER touches a provider, device, stock, sale or user model, and it
 * never changes the decision `status`, `version` or the human resolution.
 *
 * SELECT SAFETY: `APPLICATION_OUTCOME_STATE_SELECT` is the exact type-safe
 * allowlist for classification/replay (version, status, resolvedAt, the
 * terminal evidence and the backend ACK); a widened Prisma row can never leak
 * PII/authority columns into the acknowledgment.
 *
 * KNOWN RESIDUAL LIMITS (documented, NOT proven here):
 *   * The DB-free spec mocks Prisma, so it proves the adapter seams, NOT real
 *     PostgreSQL row locking, the DB CHECK or a two-writer race. A dedicated
 *     PostgreSQL integration slice owns that proof.
 *   * Bot `attemptedAt`/`providerAcceptedObservedAt` are claims, not independent
 *     proof of device delivery; `ackReceivedAt` is the backend clock and is
 *     independent of them.
 *   * Server clock: `ackReceivedAt` defaults to `new Date()` (or the injected
 *     clock) and is an audit timestamp only, never an ordering guarantee.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  DELIVERY_UNKNOWN,
  hashBotApplicationOutcomeEvidence,
  parseBotApplicationOutcomeRequest,
  PROVIDER_ACCEPTED,
  PROVIDER_ACCEPTED_LATE,
  STALE,
  type BotApplicationOutcomeRequest,
} from '../domain/bot-application-outcome.request';
import {
  BotApplicationOutcomeError,
  type BotApplicationOutcomeAcknowledgment,
  type BotApplicationOutcomeErrorCode,
  type BotApplicationOutcomeResult,
  type IBotApplicationOutcomeRepository,
  type RecordBotApplicationOutcomeCommand,
} from '../domain/bot-application-outcome.repository';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import { EXPIRATION_TYPE } from '../domain/expiration-intake.request';

type TenantScopedClient = ReturnType<TenantPrismaService['getClient']>;

/**
 * Exact internal state SELECT: the fields needed to gate the CAS
 * (`type`/`status`/`version`/`resolvedAt`), to classify a persisted terminal
 * (`applicationOutcome`/`applicationAttemptId`/`applicationEvidenceHash`) and
 * to rebuild the acknowledgment (`id`/`status`/`version`/`ackReceivedAt`). The
 * provider/bot evidence columns are WRITTEN, never read back, and no PII or
 * authority column is selected.
 */
export const APPLICATION_OUTCOME_STATE_SELECT = {
  id: true,
  type: true,
  status: true,
  version: true,
  resolvedAt: true,
  applicationOutcome: true,
  applicationAttemptId: true,
  applicationEvidenceHash: true,
  ackReceivedAt: true,
} satisfies Prisma.HumanDecisionSelect;

type ApplicationOutcomeStateRow = Prisma.HumanDecisionGetPayload<{
  select: typeof APPLICATION_OUTCOME_STATE_SELECT;
}>;

/**
 * Owner-approved half-open application window per admitted decision type:
 * `RESTOCK` keeps 1h, `EXPIRATION` gets 24h (the SQL CHECK mirrors this). Any
 * other persisted type is impossible behind the closed read/CAS admission and
 * fails closed as a value-free integrity error.
 */
function windowMsForType(type: string): number {
  switch (type) {
    case RESTOCK_TYPE:
      return 60 * 60 * 1000;
    case EXPIRATION_TYPE:
      return 24 * 60 * 60 * 1000;
    default:
      throw new Error(UNKNOWN_DECISION_TYPE_ERROR);
  }
}

/**
 * Fixed, value-free messages. Nothing here is derived from the command, so a
 * decision id, attempt id or tenant value can never leak.
 */
const ERROR_MESSAGES: Record<BotApplicationOutcomeErrorCode, string> = {
  NOT_FOUND: 'Human decision not found',
  VERSION_CONFLICT: 'Human decision version conflict',
  IDEMPOTENCY_CONFLICT: 'Application outcome conflicts with the committed ACK',
  OUTCOME_ALREADY_RECORDED:
    'A terminal application outcome is already recorded',
};

/**
 * Stable, value-free code for a bot ACK whose observed timestamps fall outside
 * the resolution window. The route-scoped filter maps the
 * `InvalidArgumentError` class to `400 VALIDATION_ERROR`; this code only tags
 * the server-side log.
 */
export const INVALID_OUTCOME_WINDOW_CODE = 'INVALID_OUTCOME_WINDOW';

/** Fixed, value-free out-of-window failure. */
function failWindow(): never {
  throw new InvalidArgumentError(
    'Bot application outcome is outside the resolution window',
    INVALID_OUTCOME_WINDOW_CODE,
  );
}

/** Throw one value-free terminal-outcome failure. */
function fail(code: BotApplicationOutcomeErrorCode): never {
  throw new BotApplicationOutcomeError(code, ERROR_MESSAGES[code]);
}

/**
 * Value-free programmer-context error for a nested `record()`. A plain `Error`
 * on purpose: the ambient-transaction misuse is a server bug and must never
 * surface as a replay or a sanitized client conflict.
 */
const NESTED_TRANSACTION_ERROR =
  'PrismaBotApplicationOutcomeRepository.record must be called outside an ambient transaction';

/**
 * Value-free programmer-context error for an unexpected `updateMany` count. The
 * CAS is scoped by the primary-key `id`, so it can only affect 0 or 1 row; any
 * other value is an integrity/server bug and must roll the transaction back
 * instead of being misclassified as a loser or a fabricated 409.
 */
const UNEXPECTED_UPDATE_COUNT_ERROR =
  'PrismaBotApplicationOutcomeRepository.record observed an unexpected updateMany count';

/** Value-free integrity error for a persisted type outside the closed set. */
const UNKNOWN_DECISION_TYPE_ERROR =
  'PrismaBotApplicationOutcomeRepository.record observed an unsupported decision type';

/** Value-free integrity error for a RESOLVED row missing `resolvedAt`. */
const MISSING_RESOLVED_AT_ERROR =
  'PrismaBotApplicationOutcomeRepository.record observed a RESOLVED decision without resolvedAt';

/** Value-free integrity error for a terminal row missing ACK columns. */
const MISSING_TERMINAL_COLUMNS_ERROR =
  'PrismaBotApplicationOutcomeRepository.record observed a terminal outcome without its ACK columns';

/** Optional server clock, bound by HD-05c; defaults to `new Date()`. */
export type BotApplicationOutcomeClock = () => Date;

/** Injection token for the optional clock; absent => `new Date()`. */
export const BOT_APPLICATION_OUTCOME_CLOCK = Symbol(
  'BOT_APPLICATION_OUTCOME_CLOCK',
);

/** Map the outcome to its persisted provider message id (audit/evidence). */
function providerMessageIdOf(
  request: BotApplicationOutcomeRequest,
): string | null {
  if (
    request.outcome === PROVIDER_ACCEPTED ||
    request.outcome === PROVIDER_ACCEPTED_LATE
  ) {
    return request.providerMessageId;
  }
  if (request.outcome === DELIVERY_UNKNOWN) {
    return request.providerMessageId ?? null;
  }
  return null;
}

/** Map the outcome to its persisted bot-observed acceptance timestamp. */
function providerAcceptedObservedAtOf(
  request: BotApplicationOutcomeRequest,
): Date | null {
  if (
    request.outcome === PROVIDER_ACCEPTED ||
    request.outcome === PROVIDER_ACCEPTED_LATE
  ) {
    return new Date(request.providerAcceptedObservedAt);
  }
  return null;
}

/** Map the outcome to its persisted bot-observed attempt timestamp. */
function attemptedAtOf(request: BotApplicationOutcomeRequest): Date | null {
  if (request.outcome === STALE) {
    return null;
  }
  return new Date(request.attemptedAt);
}

@Injectable()
export class PrismaBotApplicationOutcomeRepository implements IBotApplicationOutcomeRepository {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @Optional()
    @Inject(BOT_APPLICATION_OUTCOME_CLOCK)
    private readonly clock?: BotApplicationOutcomeClock,
  ) {}

  async record(
    command: RecordBotApplicationOutcomeCommand,
  ): Promise<BotApplicationOutcomeResult> {
    // Fail closed BEFORE any query/transaction; see the class-level
    // TRANSACTION PRECONDITION. `isInTransaction()` only reads CLS.
    if (this.tenantPrisma.isInTransaction()) {
      throw new Error(NESTED_TRANSACTION_ERROR);
    }

    // Tenant is ALWAYS from the CLS context, never the command, and is
    // resolved unconditionally so a tenantless superadmin fails closed.
    const tenantId = this.tenantPrisma.getTenantId();

    // Defensive runtime re-parse + server-derived hash. Both re-validate, so an
    // unsafe caller handing raw JS fails closed before any DB work and a
    // client-supplied hash is never trusted. Pure, so it stays outside the tx.
    const request = parseBotApplicationOutcomeRequest(command.request);
    const evidenceHash = hashBotApplicationOutcomeEvidence(request);
    const ackReceivedAt = this.now();

    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();

      const current = await this.findDecisionState(
        db,
        tenantId,
        command.decisionId,
      );
      if (current === null) {
        return fail('NOT_FOUND');
      }
      this.assertEligibleResolution(current, request);

      if (current.applicationOutcome !== null) {
        return this.classifyTerminal(current, request, evidenceHash);
      }

      const resolvedAt = current.resolvedAt;
      if (resolvedAt === null) {
        throw new Error(MISSING_RESOLVED_AT_ERROR);
      }
      this.assertTemporalWindow(request, resolvedAt, current.type);

      const updated = await db.humanDecision.updateMany({
        where: {
          id: command.decisionId,
          tenantId,
          source: RESTOCK_SOURCE,
          type: { in: [RESTOCK_TYPE, EXPIRATION_TYPE] },
          status: 'RESOLVED',
          version: 2,
          applicationOutcome: null,
        },
        data: this.buildOutcomeData(request, evidenceHash, ackReceivedAt),
      });

      if (updated.count === 1) {
        const committed = await this.findDecisionState(
          db,
          tenantId,
          command.decisionId,
        );
        if (committed === null) {
          throw new Error(MISSING_TERMINAL_COLUMNS_ERROR);
        }
        return {
          status: 'recorded',
          acknowledgment: this.toAcknowledgment(committed),
        };
      }

      // The CAS is scoped by primary-key `id`, so a trusted updateMany can only
      // affect 0 or 1 row. Any other count is an integrity/programmer error:
      // throw a value-free plain Error so the transaction rolls back.
      if (updated.count !== 0) {
        throw new Error(UNEXPECTED_UPDATE_COUNT_ERROR);
      }

      // count === 0: a concurrent writer won the CAS. Re-read the committed
      // winner inside this transaction and classify it identically to a direct
      // terminal read.
      const winner = await this.findDecisionState(
        db,
        tenantId,
        command.decisionId,
      );
      if (winner === null) {
        return fail('VERSION_CONFLICT');
      }
      this.assertEligibleResolution(winner, request);
      if (winner.applicationOutcome === null) {
        return fail('VERSION_CONFLICT');
      }
      return this.classifyTerminal(winner, request, evidenceHash);
    });
  }

  /** Tenant/source/type-scoped decision state; never a full row. */
  private async findDecisionState(
    db: TenantScopedClient,
    tenantId: string,
    decisionId: string,
  ): Promise<ApplicationOutcomeStateRow | null> {
    return db.humanDecision.findFirst({
      where: {
        id: decisionId,
        tenantId,
        source: RESTOCK_SOURCE,
        type: { in: [RESTOCK_TYPE, EXPIRATION_TYPE] },
      },
      select: APPLICATION_OUTCOME_STATE_SELECT,
    });
  }

  /**
   * The decision must be `RESOLVED` at exactly version 2 and the request must
   * target that version. Any other state is a value-free `VERSION_CONFLICT`.
   */
  private assertEligibleResolution(
    row: ApplicationOutcomeStateRow,
    request: BotApplicationOutcomeRequest,
  ): void {
    if (row.status !== 'RESOLVED') {
      return fail('VERSION_CONFLICT');
    }
    if (request.expectedResolutionVersion !== 2) {
      return fail('VERSION_CONFLICT');
    }
    if (row.version !== request.expectedResolutionVersion) {
      return fail('VERSION_CONFLICT');
    }
  }

  /**
   * Half-open `[resolvedAt, resolvedAt + window(type))` window on the
   * bot-observed attempt, plus the acceptance-vs-deadline split; the window is
   * 1h for `RESTOCK` and 24h for `EXPIRATION`. `STALE` carries no send evidence
   * (the parser guarantees it), so it has no window to check.
   */
  private assertTemporalWindow(
    request: BotApplicationOutcomeRequest,
    resolvedAt: Date,
    type: string,
  ): void {
    if (request.outcome === STALE) {
      return;
    }

    const windowStart = resolvedAt.getTime();
    const windowEnd = windowStart + windowMsForType(type);
    const attemptedMs = new Date(request.attemptedAt).getTime();
    if (attemptedMs < windowStart || attemptedMs >= windowEnd) {
      return failWindow();
    }

    if (request.outcome === PROVIDER_ACCEPTED) {
      const observedMs = new Date(request.providerAcceptedObservedAt).getTime();
      if (observedMs >= windowEnd) {
        return failWindow();
      }
      return;
    }

    if (request.outcome === PROVIDER_ACCEPTED_LATE) {
      const observedMs = new Date(request.providerAcceptedObservedAt).getTime();
      if (observedMs < windowEnd) {
        return failWindow();
      }
    }
  }

  /**
   * Classify an already-terminal decision: exact attempt + hash is a replay;
   * the same attempt with a changed hash is `IDEMPOTENCY_CONFLICT`; any other
   * attempt is `OUTCOME_ALREADY_RECORDED` (including UNKNOWN/LATE holds). No
   * time window is re-validated, so a replay stays stable after the deadline.
   */
  private classifyTerminal(
    row: ApplicationOutcomeStateRow,
    request: BotApplicationOutcomeRequest,
    evidenceHash: string,
  ): BotApplicationOutcomeResult {
    if (row.applicationAttemptId !== request.attemptId) {
      return fail('OUTCOME_ALREADY_RECORDED');
    }
    if (row.applicationEvidenceHash !== evidenceHash) {
      return fail('IDEMPOTENCY_CONFLICT');
    }
    return { status: 'replayed', acknowledgment: this.toAcknowledgment(row) };
  }

  /** Rebuild the exact five-key acknowledgment from a committed terminal row. */
  private toAcknowledgment(
    row: ApplicationOutcomeStateRow,
  ): BotApplicationOutcomeAcknowledgment {
    if (
      row.applicationOutcome === null ||
      row.applicationAttemptId === null ||
      row.ackReceivedAt === null
    ) {
      throw new Error(MISSING_TERMINAL_COLUMNS_ERROR);
    }
    return {
      id: row.id,
      version: 2,
      attemptId: row.applicationAttemptId,
      outcome: row.applicationOutcome,
      ackReceivedAt: row.ackReceivedAt,
    };
  }

  /**
   * The ONLY write: the terminal outcome columns. `status`, `version` and the
   * human resolution are deliberately untouched, and `applicationEvidenceCode`
   * is always `null` because the wire carries no approved evidence-code enum.
   */
  private buildOutcomeData(
    request: BotApplicationOutcomeRequest,
    evidenceHash: string,
    ackReceivedAt: Date,
  ): Prisma.HumanDecisionUncheckedUpdateManyInput {
    return {
      applicationOutcome: request.outcome,
      applicationAttemptId: request.attemptId,
      applicationEvidenceHash: evidenceHash,
      applicationEvidenceCode: null,
      providerMessageId: providerMessageIdOf(request),
      providerAcceptedObservedAt: providerAcceptedObservedAtOf(request),
      applicationAttemptedAt: attemptedAtOf(request),
      ackReceivedAt,
    };
  }

  /** Server clock; `new Date()` unless HD-05c binds a clock. */
  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }
}
