/**
 * Pure rules of the overdue-ETA re-estimate (restock-backorder / T4; contract
 * v1 §8, owner D6, chatbot adjustment «UN re-estimado por (tenant, productId,
 * variantId)»). No I/O: the sweep and the resolution listener load the rows
 * under their locks and these functions decide, so every rule is unit tested
 * without a database.
 *
 * `etaStage`: 0 none, 1 re-estimate requested (the customer is told nothing),
 * 2 answered (the customer got `backorder.eta_updated` / `eta_unavailable`).
 */
import { createHash } from 'node:crypto';

export const ETA_STAGE = {
  NONE: 0,
  REQUESTED: 1,
  ANSWERED: 2,
} as const;

/**
 * `submittedCredentialId` of the server-created RESTOCK decisions. There is no
 * service credential behind them (no bot, no request), so this is a documented
 * constant system id: it is also how the sweep recognises «a re-estimate
 * decision for this product» among the RESTOCK decisions of the tenant (the
 * bot's own decisions carry the id of the credential that submitted them).
 * The column has no FK by design, so a constant is valid.
 */
export const REESTIMATE_SYSTEM_CREDENTIAL_ID =
  'system:backorder-eta-reestimate';

const DAY_MS = 86_400_000;

/** `''` for a product without variants (the sweep's keyset and the lock keys). */
export const variantKeyOf = (variantId: string | null): string =>
  variantId ?? '';

/**
 * The `sourceRequestId` (the decision's idempotent identity) of round `round`
 * of a product/variant: a UUID derived from tenant + product + variant + round,
 * so concurrent ticks and replicas that decide to open the same round compute
 * the same identity and `submit` turns the second into a replay. Round `n + 1`
 * is only opened once round `n` was answered.
 */
export function reestimateSourceRequestId(
  tenantId: string,
  productId: string,
  variantId: string | null,
  round: number,
): string {
  const bytes = createHash('sha256')
    .update(
      `backorder-eta-reestimate:${tenantId}:${productId}:${variantKeyOf(variantId)}:${round}`,
      'utf8',
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5 layout
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** What the sweep needs of a backorder to decide whether it asks for an ETA. */
export interface OverdueCandidate {
  status: string;
  etaStage: number;
  estimatedAt: Date;
}

/** WAITING, `estimatedAt` passed, nothing asked yet: the only rows that ask. */
export function isOverdueForReestimate(
  row: OverdueCandidate,
  now: Date,
): boolean {
  return (
    row.status === 'WAITING' &&
    row.etaStage === ETA_STAGE.NONE &&
    row.estimatedAt.getTime() < now.getTime()
  );
}

/** The re-estimate decision rows of one product/variant, as the sweep reads them. */
export interface ReestimateDecisionState {
  /** The oldest PENDING re-estimate decision, if any. */
  pendingDecisionId: string | null;
  /** All re-estimate decisions ever created for it (any status). */
  decisionsCreated: number;
}

export type ReestimatePlan =
  | { kind: 'attach'; decisionId: string }
  | { kind: 'create'; round: number };

/**
 * One re-estimate per (tenant, product, variant) at a time: a pending decision
 * absorbs every newly overdue backorder; otherwise the next round is opened.
 */
export function planReestimate(state: ReestimateDecisionState): ReestimatePlan {
  if (state.pendingDecisionId !== null) {
    return { kind: 'attach', decisionId: state.pendingDecisionId };
  }
  return { kind: 'create', round: state.decisionsCreated + 1 };
}

export type EtaResolution =
  | { kind: 'ESTIMATE'; estimatedAt: Date; restockDays: number }
  | { kind: 'UNAVAILABLE' };

/**
 * What a staff resolution means for the attached backorders:
 * `PROVIDE_RESTOCK_ESTIMATE` → `estimatedAt = resolvedAt + restockDays`;
 * `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE` → no new estimate. Anything else (an
 * EXPIRATION action, a provide without days) is not a RESTOCK answer: `null`.
 */
export function planEtaResolution(decision: {
  action: string | null;
  restockDays: number | null;
  resolvedAt: Date | null;
}): EtaResolution | null {
  if (
    decision.action === 'PROVIDE_RESTOCK_ESTIMATE' &&
    decision.restockDays !== null &&
    decision.restockDays > 0 &&
    decision.resolvedAt !== null
  ) {
    return {
      kind: 'ESTIMATE',
      restockDays: decision.restockDays,
      estimatedAt: new Date(
        decision.resolvedAt.getTime() + decision.restockDays * DAY_MS,
      ),
    };
  }
  if (decision.action === 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE') {
    return { kind: 'UNAVAILABLE' };
  }
  return null;
}

/**
 * Fan-out of an answer: only a still-`WAITING` backorder that is attached to
 * the decision (`etaStage = 1`) receives it; a backorder that was reserved,
 * confirmed, cancelled or expired meanwhile is skipped (no message).
 */
export function receivesEtaAnswer(
  row: {
    status: string;
    etaStage: number;
    reestimateDecisionId: string | null;
  },
  decisionId: string,
): boolean {
  return (
    row.status === 'WAITING' &&
    row.etaStage === ETA_STAGE.REQUESTED &&
    row.reestimateDecisionId === decisionId
  );
}
