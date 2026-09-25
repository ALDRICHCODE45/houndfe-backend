/**
 * HD-02b1 — PORT: IRestockIntakeRepository (driven port).
 *
 * Persistence contract for the tenant-scoped RESTOCK human-decision intake.
 * The concrete adapter is `infrastructure/prisma-restock-intake.repository.ts`
 * and is wired into the NestJS DI container via the
 * `RESTOCK_INTAKE_REPOSITORY` symbol (HD-03 owns the module wiring).
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * TRUST BOUNDARY: the caller passes only bot/request fields plus the
 * server-derived `submittedCredentialId` (from `ServiceAuthGuard`). The
 * adapter NEVER reads `tenantId`, `source`, `type`, `branchId` or
 * `branchName` from this payload: tenant comes from
 * `TenantPrismaService.getTenantId()`, `source`/`type` are fixed server
 * constants and both branch fields are derived from the tenant row. Any
 * runtime key with those names is ignored.
 *
 * IDENTITY: `(tenantId, source, sourceRequestId)` is the idempotent intake
 * identity. The canonical hash excludes the rotating credential, so an exact
 * replay after credential rotation returns the SAME persisted request with
 * `status: 'replayed'` and overwrites NO audit data. The same identity with a
 * different canonical hash is `IDEMPOTENCY_CONFLICT`.
 *
 * SUPERSESSION: `supersedesDecisionId` is optional. The predecessor must
 * belong to the same tenant and source and must be durably `STALE`; a missing
 * or cross-tenant predecessor is a sanitized `NOT_FOUND`, and any other
 * outcome (including `null`, `DELIVERY_UNKNOWN` and
 * `PROVIDER_ACCEPTED_LATE`) is a sanitized `VERSION_CONFLICT`. The schema has
 * no explicit audited-reconciliation transition in v1, so nothing else is
 * ever treated as eligible.
 *
 * ERROR SAFETY: every error is value-free. Messages never echo product
 * names, SKUs, credentials, tenant ids or the source request id, and a
 * cross-tenant predecessor is never distinguishable from a missing one.
 */
import { DomainError } from '../../shared/domain/domain-error';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
  type RestockRequestInput,
} from './restock-request-canonicalizer';

/**
 * Sanitized conflict codes the intake adapter can raise. They map 1:1 onto
 * the scoped RESTOCK error envelope (`NOT_FOUND` -> 404,
 * `IDEMPOTENCY_CONFLICT` / `VERSION_CONFLICT` -> 409) that HD-03 owns.
 */
export type RestockIntakeErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'NOT_FOUND';

/** Value-free intake failure. Never carries payload values in `message`. */
export class RestockIntakeError extends DomainError {
  constructor(code: RestockIntakeErrorCode, message: string) {
    super(message, code);
  }
}

/**
 * Adapter input: every bot/request field the canonicalizer accepts, minus
 * `tenantId` (server-derived) but including the server-derived
 * `submittedCredentialId` for the immutable audit column.
 */
export type RestockIntakeInput = Omit<RestockRequestInput, 'tenantId'>;

/** Persisted decision state. `RESOLVED` is never produced by intake. */
export type PersistedRestockDecisionStatus = 'PENDING' | 'RESOLVED';

/**
 * Immutable, sanitized snapshot projection for the future detail DTO.
 * `branchId`/`branchName` are tenant-derived by the backend; the bot never
 * supplies them. `observedStockAtRequest`/`stockObservedAt` are both null or
 * both present.
 */
export interface PersistedRestockDecisionSnapshot {
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  variantId: string | null;
  sku: string | null;
  requestedQuantity: number | null;
  observedStockAtRequest: number | null;
  stockObservedAt: Date | null;
}

/** Persisted RESTOCK decision returned by the intake adapter. */
export interface PersistedRestockDecision {
  id: string;
  source: typeof RESTOCK_SOURCE;
  sourceRequestId: string;
  type: typeof RESTOCK_TYPE;
  canonicalRequestHash: string;
  status: PersistedRestockDecisionStatus;
  version: number;
  supersedesDecisionId: string | null;
  createdAt: Date;
  snapshot: PersistedRestockDecisionSnapshot;
}

/**
 * Discriminable intake result: `created` maps to HTTP 201, `replayed` maps to
 * HTTP 200 with the same persisted request. Both carry the same typed request.
 */
export type RestockIntakeResult =
  | { status: 'created'; request: PersistedRestockDecision }
  | { status: 'replayed'; request: PersistedRestockDecision };

export interface IRestockIntakeRepository {
  /**
   * Create the first `PENDING`/version-1 decision for the idempotent
   * `(tenantId, source, sourceRequestId)` identity, or replay the persisted
   * one when the canonical hash matches. Throws `RestockIntakeError` for
   * sanitized identity/supersession conflicts, and rethrows unrelated
   * persistence failures untouched.
   */
  submit(input: RestockIntakeInput): Promise<RestockIntakeResult>;
}

/** Injection token used by NestJS DI to resolve the interface. */
export const RESTOCK_INTAKE_REPOSITORY = Symbol('RESTOCK_INTAKE_REPOSITORY');
