/**
 * HD-EXP-03 — BotExpirationIntakeResponse: bot EXPIRATION intake RECEIPT.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-expiration-v1.md`.
 *
 * Same immutability rule as the RESTOCK receipt: the guarded `POST` intake
 * route returns the HISTORICAL receipt captured at intake. First create is
 * HTTP 201 and an exact replay is HTTP 200, and BOTH carry identical values
 * from the immutable columns (`id`, `sourceRequestId`, `createdAt`,
 * `snapshot`). The receipt is therefore always `status:'PENDING'`,
 * `version:1`, `resolution:null`, `applyBefore:null` and
 * `supersedesDecisionId:null`, even when the persisted row has since been
 * RESOLVED. `GET /chatbot-api/human-decisions/:id` is the ONLY source that
 * exposes current state.
 *
 * The persisted snapshot field `productUnit` is rendered as the contract key
 * `unit`; there is no SKU on an EXPIRATION decision. `branchName` lives in the
 * immutable snapshot, so an exact replay after a tenant rename still returns
 * the name captured at intake.
 *
 * Deliberately ABSENT (bot-safe shape): `sku`, `source`,
 * `canonicalRequestHash`, `submittedCredentialId`, `tenantId`,
 * reviewer/audit fields, customer/PII, `updatedAt` and `allowedActions`. The
 * mapper reads only the allowlisted immutable fields and ignores the mutable
 * persisted `status`/`version`.
 */
import { EXPIRATION_TYPE } from '../../domain/expiration-intake.request';
import type {
  ExpirationIntakeSnapshot,
  PersistedExpirationDecision,
} from '../../domain/expiration-intake.repository';

/** Immutable snapshot projection returned inside the intake receipt. */
export interface BotExpirationIntakeSnapshotResponse {
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  /** `Product.unit` for both simple and variant products. */
  unit: string;
  variantId: string | null;
  variantName: string | null;
  variantOption: string | null;
  variantValue: string | null;
}

/** Exact bot-safe immutable intake receipt body. */
export interface BotExpirationIntakeResponse {
  id: string;
  sourceRequestId: string;
  type: typeof EXPIRATION_TYPE;
  status: 'PENDING';
  version: 1;
  /** Canonical UTC ISO string. */
  createdAt: string;
  snapshot: BotExpirationIntakeSnapshotResponse;
  supersedesDecisionId: null;
  resolution: null;
  applyBefore: null;
}

function toSnapshot(
  snapshot: ExpirationIntakeSnapshot,
): BotExpirationIntakeSnapshotResponse {
  return {
    branchId: snapshot.branchId,
    branchName: snapshot.branchName,
    productId: snapshot.productId,
    productName: snapshot.productName,
    unit: snapshot.productUnit,
    variantId: snapshot.variantId,
    variantName: snapshot.variantName,
    variantOption: snapshot.variantOption,
    variantValue: snapshot.variantValue,
  };
}

/**
 * Pure projection from the persisted EXPIRATION decision to the immutable
 * intake receipt. Converts `createdAt` to a canonical UTC ISO string without
 * mutating the input, and intentionally ignores the mutable persisted
 * `status`/`version`.
 */
export function toBotExpirationIntakeResponse(
  decision: PersistedExpirationDecision,
): BotExpirationIntakeResponse {
  return {
    id: decision.id,
    sourceRequestId: decision.sourceRequestId,
    type: EXPIRATION_TYPE,
    status: 'PENDING',
    version: 1,
    createdAt: decision.createdAt.toISOString(),
    snapshot: toSnapshot(decision.snapshot),
    supersedesDecisionId: null,
    resolution: null,
    applyBefore: null,
  };
}
