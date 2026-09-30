/**
 * HD-05a1 — PORT: IBotRestockPollRepository (bot poll driven read port).
 *
 * Tenant-scoped CURRENT-state read contract for the bot `GET` poll. Unlike the
 * immutable POST intake receipt (HD-03b1), this is the ONLY projection that
 * exposes the decision's current `PENDING`/`RESOLVED` state.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("Historical POST vs current GET").
 *
 * TRUST BOUNDARY: the caller supplies ONLY an `id`. `tenantId`, `source` and
 * `type` are NEVER taken from the caller. The adapter resolves `tenantId` from
 * `TenantPrismaService.getTenantId()`, which throws when no tenant context
 * exists — INCLUDING for a superadmin session — and pins `source`/`type` to
 * the RESTOCK server constants in every WHERE clause. `findById` therefore
 * never uses `findUnique` by id alone: a missing, cross-tenant or
 * foreign-source id is indistinguishable and returns `null`.
 *
 * SELECT SAFETY: the adapter selects ONLY the fields this record declares.
 * Reviewer identity (`resolvedById`, its snapshot columns or a `User`
 * relation), authority/server-only columns (`source`, `tenantId`,
 * `canonicalRequestHash`, `submittedCredentialId`, `resolutionRequestId`),
 * provider/ACK/outcome evidence and customer PII are NEVER read into the poll
 * model. There is deliberately NO `source` field on the record: the adapter
 * owns that predicate, so a caller can never widen the projection.
 *
 * NO PRESENTATION COUPLING: this port does not reference the presentation DTO.
 * The record shape lives here so the pure mapper
 * (`toBotRestockPollResponse`) and the future HD-05b Prisma adapter share ONE
 * type and cannot drift. The mapper re-validates the persisted row at runtime
 * because a database row is never trusted blindly.
 *
 * SCOPE: DB-FREE foundation only. This slice adds NO Prisma adapter, HTTP
 * controller, module binding or application-outcome ACK; HD-05b/HD-05c own
 * those.
 *
 * EXPIRATION STAGING: the EXPIRATION-only fields are OPTIONAL so the committed
 * HD-05b RESTOCK adapter and every fixture stay type-compatible (a RESTOCK
 * record without them is NOT a failure); `toBotExpirationPollResponse` instead
 * fails closed when a required one is absent or inconsistent.
 */
import { DomainError } from '../../shared/domain/domain-error';

/**
 * Immutable intake snapshot projected by the poll. Exactly the same nine keys
 * as the HD-03b1 historical receipt, because both read the same immutable
 * persisted snapshot. `branchId`/`branchName` are tenant-derived by the
 * backend and captured at intake, so a later tenant rename never changes them.
 *
 * `observedStockAtRequest`/`stockObservedAt` are both `null` or both present.
 */
export interface BotRestockPollSnapshotRecord {
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  variantId: string | null;
  sku: string | null;
  requestedQuantity: number | null;
  observedStockAtRequest: number | null;
  stockObservedAt: Date | null;
  /**
   * EXPIRATION-only snapshot fields; absent/`null` on RESTOCK, all `null` on a
   * simple product. Wire `unit` renders from `productUnit`; `variantName` is
   * required when `variantId` is set. OPTIONAL for adapter/fixture staging.
   */
  productUnit?: string | null;
  variantName?: string | null;
  variantOption?: string | null;
  variantValue?: string | null;
}

/**
 * Current persisted row shape consumed by the bot poll mapper. Structurally
 * compatible with a selected Prisma `HumanDecision` row (the wider
 * `string`/`number` fields accept the generated enum values); the mapper
 * re-validates every invariant at runtime.
 *
 * This is the exact SELECT allowlist of the future HD-05b poll adapter.
 * Adding a field here is a deliberate widening of what the bot may read, so it
 * must never include reviewer identity, authority, credential, provider/ACK or
 * customer fields.
 *
 * `resolutionAction`/`restockDays`/`resolvedAt` are the mutable persisted
 * resolution columns, `null` while `status` is `PENDING`.
 */
export interface BotRestockPollRecord {
  id: string;
  sourceRequestId: string;
  type: string;
  status: string;
  version: number;
  createdAt: Date;
  snapshot: BotRestockPollSnapshotRecord;
  supersedesDecisionId: string | null;
  resolutionAction: string | null;
  restockDays: number | null;
  resolvedAt: Date | null;
  /**
   * EXPIRATION-only operator text (`PROVIDE_EXPIRATION_TEXT`); absent/`null`
   * otherwise. OPTIONAL for adapter/fixture staging.
   */
  expirationText?: string | null;
}

/**
 * Value-free poll read failure. Raised only for a programmer/transport-bypass
 * argument (a missing, non-string or non-canonical id) so a caller that
 * bypasses the transport cannot reach Prisma with an unvalidated value. The
 * message NEVER echoes the rejected id, so it is safe to surface as a generic
 * 5xx by the scoped error filter.
 */
export class BotRestockPollReadError extends DomainError {
  constructor() {
    super('Invalid bot restock poll read argument', 'INVALID_READ_ARGUMENT');
  }
}

export interface IBotRestockPollRepository {
  /**
   * One tenant-scoped decision by id in its CURRENT state, `PENDING` or
   * `RESOLVED`. Returns `null` for a missing OR cross-tenant id (the two are
   * indistinguishable to the caller), and pins `source`/`type` to the RESTOCK
   * server constants in the same WHERE clause. Never uses `findUnique` by id
   * alone.
   */
  findById(id: string): Promise<BotRestockPollRecord | null>;
}

/** Injection token used by NestJS DI to resolve the interface (HD-05b wires it). */
export const BOT_RESTOCK_POLL_REPOSITORY = Symbol(
  'BOT_RESTOCK_POLL_REPOSITORY',
);
