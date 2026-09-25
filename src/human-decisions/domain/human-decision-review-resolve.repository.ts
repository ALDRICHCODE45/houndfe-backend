/**
 * HD-04c2 — PORT: IHumanDecisionReviewResolveRepository (driven resolve port).
 *
 * Versioned, audited ONE-WINNER resolution contract for a tenant-scoped
 * RESTOCK human decision. The concrete adapter is
 * `infrastructure/prisma-human-decision-review-resolve.repository.ts`; HD-04d
 * owns the NestJS binding (`HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY`) and the
 * controller that derives the reviewer actor from the JWT.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("Resolution is an exact discriminated union").
 *
 * TRUST BOUNDARY: the command carries the EXACT resolve payload
 * (`action`/`restockDays`/`expectedVersion`/`resolutionRequestId`) PLUS the
 * server-derived `actorUserId`/`actorIsSuperAdmin`. The actor fields come from
 * the JWT/guard — NEVER from the request body — and `tenantId` is never a
 * command field: the adapter resolves it from `TenantPrismaService`, so a
 * superadmin without a selected tenant fails closed.
 *
 * ONE-WINNER CAS: a `PENDING` decision is resolved by a single conditional
 * `updateMany` on `(id, tenantId, source, type, status='PENDING',
 * version=expectedVersion)`. Exactly one concurrent reviewer flips version
 * `1 -> 2`; every loser re-reads the committed winner and is classified as an
 * idempotent replay, an idempotency conflict or an already-resolved conflict.
 *
 * IDEMPOTENT REPLAY: the same `resolutionRequestId` + exact action/days +
 * `expectedVersion=1` + same actor id replays the committed result with NO
 * mutation, preserving the persisted `resolvedAt` and reviewer snapshot. The
 * same key with a different payload/actor is `IDEMPOTENCY_CONFLICT`; a
 * different key against a resolved decision is `ALREADY_RESOLVED`.
 *
 * ERROR SAFETY: every error is value-free and carries one stable code
 * (`NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `VERSION_CONFLICT`,
 * `IDEMPOTENCY_CONFLICT`, `ALREADY_RESOLVED`), never the decision id, the
 * resolution request id or any actor/tenant value. A missing, cross-tenant or
 * foreign-source decision is indistinguishable (`NOT_FOUND`).
 */
import { DomainError } from '../../shared/domain/domain-error';
import type { HumanDecisionReviewRecord } from './human-decision-review-read.repository';

/** Positive action: a confirmed estimate of `restockDays` natural days. */
export const HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE =
  'PROVIDE_RESTOCK_ESTIMATE';

/** Negative action: no confirmed ETA (not "will never be restocked"). */
export const HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE =
  'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE';

/** The only two persisted `HumanDecisionResolutionAction` values. */
export type HumanDecisionResolutionAction =
  | typeof HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE
  | typeof HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE;

/** Positive resolve command; `restockDays` is a natural-day count 1..365. */
export interface ResolveHumanDecisionProvideCommand {
  decisionId: string;
  expectedVersion: number;
  resolutionRequestId: string;
  action: typeof HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE;
  restockDays: number;
  actorUserId: string;
  actorIsSuperAdmin: boolean;
}

/** Negative resolve command; `restockDays` is deliberately absent. */
export interface ResolveHumanDecisionUnavailableCommand {
  decisionId: string;
  expectedVersion: number;
  resolutionRequestId: string;
  action: typeof HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE;
  actorUserId: string;
  actorIsSuperAdmin: boolean;
}

/** Exact discriminated resolve command handed to the adapter. */
export type ResolveHumanDecisionCommand =
  | ResolveHumanDecisionProvideCommand
  | ResolveHumanDecisionUnavailableCommand;

/**
 * `resolved` is the first winner; `replayed` is an exact idempotent retry.
 * Both carry the same committed reviewer projection.
 */
export type HumanDecisionReviewResolveStatus = 'resolved' | 'replayed';

export interface HumanDecisionReviewResolveResult {
  status: HumanDecisionReviewResolveStatus;
  decision: HumanDecisionReviewRecord;
}

/** Stable, value-free resolve failure codes. */
export type HumanDecisionReviewResolveErrorCode =
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ALREADY_RESOLVED';

/** Value-free resolve failure. The `message` never echoes a command value. */
export class HumanDecisionReviewResolveError extends DomainError {
  constructor(code: HumanDecisionReviewResolveErrorCode, message: string) {
    super(message, code);
  }
}

export interface IHumanDecisionReviewResolveRepository {
  /**
   * Resolve one tenant-scoped RESTOCK decision with a versioned one-winner
   * CAS. Returns `resolved` on the first commit and `replayed` on an exact
   * idempotent retry. Throws `HumanDecisionReviewResolveError` for the stable
   * value-free conflicts; unrelated persistence failures are rethrown
   * untouched.
   */
  resolve(
    command: ResolveHumanDecisionCommand,
  ): Promise<HumanDecisionReviewResolveResult>;
}

/** Injection token used by NestJS DI to resolve the interface (HD-04d wires it). */
export const HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY = Symbol(
  'HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY',
);
