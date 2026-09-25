/**
 * DTO: BotRestockIntakeResponse — HD-03b1 bot RESTOCK intake RECEIPT.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * The guarded `POST` intake route returns an IMMUTABLE HISTORICAL RECEIPT, not
 * the decision's current state. On first create it is HTTP 201 and on any
 * exact replay it is HTTP 200, and BOTH carry identical values from the
 * immutable columns (`id`, `sourceRequestId`, `type`, `createdAt`, `snapshot`,
 * `supersedesDecisionId`). The receipt is therefore always
 * `status:'PENDING'`, `version:1`, `resolution:null`, `applyBefore:null`,
 * even when the persisted row has since been resolved. `GET` bot poll (HD-05)
 * is the ONLY source that exposes the current `RESOLVED`/version `2` state;
 * the bot must never treat this receipt as the current decision.
 *
 * The persisted `branchName` lives in the immutable snapshot, so an exact
 * replay after a tenant rename still returns the name captured at intake; this
 * projection never re-reads the tenant.
 *
 * Deliberately ABSENT (bot-safe shape): `source`, `canonicalRequestHash`,
 * `submittedCredentialId`, `tenantId`, reviewer/audit fields, customer/PII,
 * `updatedAt` and `allowedActions`. The mapper reads only the allowlisted
 * immutable fields and ignores the mutable persisted `status`/`version`.
 */
import { RESTOCK_TYPE } from '../../domain/restock-request-canonicalizer';
import type {
  PersistedRestockDecision,
  PersistedRestockDecisionSnapshot,
} from '../../domain/restock-intake.repository';

/** Immutable snapshot projection returned inside the intake receipt. */
export interface BotRestockIntakeSnapshotResponse {
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  variantId: string | null;
  sku: string | null;
  requestedQuantity: number | null;
  observedStockAtRequest: number | null;
  /** Canonical UTC ISO string, or `null` when no observation was supplied. */
  stockObservedAt: string | null;
}

/** Exact bot-safe immutable intake receipt body. */
export interface BotRestockIntakeResponse {
  id: string;
  sourceRequestId: string;
  type: typeof RESTOCK_TYPE;
  status: 'PENDING';
  version: 1;
  /** Canonical UTC ISO string. */
  createdAt: string;
  snapshot: BotRestockIntakeSnapshotResponse;
  supersedesDecisionId: string | null;
  resolution: null;
  applyBefore: null;
}

function toSnapshot(
  snapshot: PersistedRestockDecisionSnapshot,
): BotRestockIntakeSnapshotResponse {
  return {
    branchId: snapshot.branchId,
    branchName: snapshot.branchName,
    productId: snapshot.productId,
    productName: snapshot.productName,
    variantId: snapshot.variantId,
    sku: snapshot.sku,
    requestedQuantity: snapshot.requestedQuantity,
    observedStockAtRequest: snapshot.observedStockAtRequest,
    stockObservedAt: snapshot.stockObservedAt
      ? snapshot.stockObservedAt.toISOString()
      : null,
  };
}

/**
 * Pure projection from the persisted decision to the immutable intake receipt.
 * Converts every `Date` to a canonical UTC ISO string without mutating the
 * input, and intentionally ignores the mutable persisted `status`/`version`.
 */
export function toBotRestockIntakeResponse(
  decision: PersistedRestockDecision,
): BotRestockIntakeResponse {
  return {
    id: decision.id,
    sourceRequestId: decision.sourceRequestId,
    type: RESTOCK_TYPE,
    status: 'PENDING',
    version: 1,
    createdAt: decision.createdAt.toISOString(),
    snapshot: toSnapshot(decision.snapshot),
    supersedesDecisionId: decision.supersedesDecisionId,
    resolution: null,
    applyBefore: null,
  };
}
