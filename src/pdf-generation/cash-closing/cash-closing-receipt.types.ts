/**
 * cash-register-closing / T5 — receipt wire contract (S7).
 *
 * The `CASH_APPLICATION` port answers a `{ kind: 'CLOSING'; id }` query with
 * an envelope whose `snapshot` value is the frozen domain
 * `CashClosingSnapshot` JSON plus a few optional presentation extras. This
 * file declares that envelope as PARSED (post-validation) types — a
 * `CashClosingReceipt` only ever exists after
 * `parseCashClosingReceipt()` has proven every field.
 *
 * The snapshot type `extends` the domain `CashClosingSnapshot` so the
 * receipt cannot drift from the frozen cut keys: the parser is forced to
 * produce exactly `sessionId`, `tenantId`, `registerId`, `folio`,
 * `cashierUserId`, `openingCents`, `expectedCents`, `declaredCents`,
 * `verifiedCents`, `verifierUserId`, `channels`, `handovers`, `countedAt`,
 * `verifiedAt`, `closedAt`, `closedByUserId`.
 *
 * Optional extras (`registerName`, actor names, notes) are normalized to
 * `string | null` — never guessed — and are used ONLY for display. No live
 * lookup or catalog read ever touches this receipt.
 */
import type { CashClosingSnapshot } from '../../cash-register/domain/cash-snapshot';

/**
 * Frozen snapshot plus the agreed optional presentation extras.
 *
 * Every extra is `string | null` after parsing; `null` means "the snapshot
 * did not offer it", never "look it up live".
 */
export interface CashClosingReceiptSnapshot extends CashClosingSnapshot {
  /** Human label for the register captured at closing time, if offered. */
  readonly registerName: string | null;
  /** Cashier display name captured at closing time, if offered. */
  readonly cashierName: string | null;
  /** Verifier display name captured at closing time, if offered. */
  readonly verifierName: string | null;
  /** Closer display name captured at closing time, if offered. */
  readonly closedByName: string | null;
  /** Declarant's own explanation for any difference. */
  readonly declarationNotes: string | null;
  /** Verifier's independent explanation for any difference. */
  readonly verificationNotes: string | null;
  /** Closer's closing notes. */
  readonly closingNotes: string | null;
}

/** Validated closing envelope handed to the A4 template. */
export interface CashClosingReceipt {
  /** Closing id (`CashClosing` row id). */
  readonly id: string;
  /** Session id echoed by the envelope; must equal the snapshot session id. */
  readonly sessionId: string;
  /** Folio echoed by the envelope; must equal the snapshot folio. */
  readonly folio: string;
  /** Envelope creation instant (ISO string, kept verbatim). */
  readonly createdAt: string;
  /** The frozen cut snapshot plus optional display extras. */
  readonly snapshot: CashClosingReceiptSnapshot;
}

/** Props for `CashClosingA4Document`. */
export interface CashClosingPdfDocumentProps {
  readonly receipt: CashClosingReceipt;
}

/** Per-page handover pagination budgets (rows per page). */
export const CASH_CLOSING_HANDOVERS_FIRST_PAGE = 5;
export const CASH_CLOSING_HANDOVERS_PAGE = 14;

/** Custody totals split by `FLOAT` (retained) vs `WITHDRAWAL` (leaves). */
export interface CashHandoverTotals {
  readonly floatDeclaredCents: number;
  readonly floatReceivedCents: number;
  readonly floatPendingCount: number;
  readonly withdrawalDeclaredCents: number;
  readonly withdrawalReceivedCents: number;
  readonly withdrawalPendingCount: number;
}
