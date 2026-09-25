/**
 * HD-05b2 — PORT: IBotApplicationOutcomeRepository (terminal bot ACK driven
 * port).
 *
 * Versioned, audited ONE-TERMINAL application-outcome contract for a
 * tenant-scoped RESTOCK human decision. The concrete adapter is
 * `infrastructure/prisma-bot-application-outcome.repository.ts`; HD-05c owns the
 * NestJS binding and the HTTP route that derives the tenant from the
 * service-credential guard.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("ACK `{attemptId,expectedResolutionVersion,outcome,providerMessageId?,
 * providerAcceptedObservedAt?,attemptedAt?,evidenceCode?}` is one TERMINAL
 * outcome per request: backend hashes the canonical allowlisted evidence,
 * exact replay of the same attempt ID/hash returns the same result, changed
 * payload or second terminal attempt returns `409`"). UNKNOWN/LATE enter the
 * per-request `NEEDS_RECONCILIATION` hold: no automatic retry, late competing
 * ACK or superseding decision.
 *
 * TRUST BOUNDARY: the command carries the decision id PLUS the EXACT parsed
 * `BotApplicationOutcomeRequest` produced by HD-05b1. `tenantId`, `source`,
 * `type`, `ackReceivedAt` and the evidence hash are NEVER command fields: the
 * adapter resolves the tenant from `TenantPrismaService`, pins `source`/`type`
 * to the RESTOCK server constants, stamps `ackReceivedAt` from the server clock
 * and derives the hash itself. A client-supplied hash is never read.
 *
 * ONE-TERMINAL CAS: exactly one ACK may commit. The decision must already be
 * `RESOLVED` at version 2, and a single conditional `updateMany` on
 * `(id, tenantId, source, type, status='RESOLVED', version=2,
 * applicationOutcome IS NULL)` writes the terminal outcome. The DB CHECK
 * `human_decisions_application_outcome_state` enforces the outcome/evidence
 * coupling and the half-open `[resolvedAt, resolvedAt + 1h)` window on the
 * PostgreSQL side.
 *
 * IDEMPOTENT REPLAY: the same persisted attempt id + canonical evidence hash
 * replays the committed acknowledgment with NO mutation, preserving the
 * persisted `ackReceivedAt` and never re-validating the time window (so a
 * replay is stable after the deadline). The same attempt id with a different
 * hash is `IDEMPOTENCY_CONFLICT`; any other attempt id is
 * `OUTCOME_ALREADY_RECORDED` (the decision already holds a terminal outcome,
 * including the UNKNOWN/LATE reconciliation hold).
 *
 * ERROR SAFETY: every failure is value-free and carries one stable code
 * (`NOT_FOUND`, `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`,
 * `OUTCOME_ALREADY_RECORDED`), never the decision id, attempt id, provider
 * message id or any tenant value. A missing, cross-tenant or foreign-source
 * decision is indistinguishable (`NOT_FOUND`). An out-of-contract bot
 * timestamp window fails with the fixed value-free `InvalidArgumentError` and
 * maps to `400`, never to a false terminal record.
 */
import { DomainError } from '../../shared/domain/domain-error';
import type {
  BotApplicationOutcome,
  BotApplicationOutcomeRequest,
} from './bot-application-outcome.request';

/**
 * `recorded` is the first terminal commit; `replayed` is an exact idempotent
 * retry of the same attempt id + evidence hash.
 */
export type BotApplicationOutcomeStatus = 'recorded' | 'replayed';

/**
 * Back-end acknowledgment, the exact five keys the future HD-05 HTTP response
 * DTO projects (`{id,version,attemptId,outcome,ackReceivedAt}`). `version` is
 * the pinned decision version 2; an ACK never changes the decision version.
 * `ackReceivedAt` is the backend receipt clock, distinct from the bot-observed
 * provider timestamp.
 */
export interface BotApplicationOutcomeAcknowledgment {
  id: string;
  version: 2;
  attemptId: string;
  outcome: BotApplicationOutcome;
  ackReceivedAt: Date;
}

export interface BotApplicationOutcomeResult {
  status: BotApplicationOutcomeStatus;
  acknowledgment: BotApplicationOutcomeAcknowledgment;
}

/** Exact terminal ACK command handed to the adapter. */
export interface RecordBotApplicationOutcomeCommand {
  decisionId: string;
  request: BotApplicationOutcomeRequest;
}

/** Stable, value-free terminal-outcome failure codes. */
export type BotApplicationOutcomeErrorCode =
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OUTCOME_ALREADY_RECORDED';

/** Value-free failure. The `message` never echoes a command value. */
export class BotApplicationOutcomeError extends DomainError {
  constructor(code: BotApplicationOutcomeErrorCode, message: string) {
    super(message, code);
  }
}

export interface IBotApplicationOutcomeRepository {
  /**
   * Record one tenant-scoped terminal application outcome with a one-terminal
   * CAS. Returns `recorded` on the first commit and `replayed` on an exact
   * idempotent retry. Throws `BotApplicationOutcomeError` for the stable
   * value-free conflicts and `InvalidArgumentError` for an out-of-contract bot
   * time window; unrelated persistence failures are rethrown untouched so the
   * scoped filter sanitizes them into a `500`.
   */
  record(
    command: RecordBotApplicationOutcomeCommand,
  ): Promise<BotApplicationOutcomeResult>;
}

/** Injection token used by NestJS DI to resolve the interface (HD-05c wires it). */
export const BOT_APPLICATION_OUTCOME_REPOSITORY = Symbol(
  'BOT_APPLICATION_OUTCOME_REPOSITORY',
);
