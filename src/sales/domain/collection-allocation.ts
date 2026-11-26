/**
 * customer-collection / T2 (S2, S3) — pure allocation of a «Cobrar todo»
 * over the open-debt sales of one customer (contract v1 §3, §4).
 *
 * - Order (owner Q1 «Vencimiento más viejo primero»): due DAY ascending (the
 *   UTC calendar date of `dueDate`, the day the POS shows and the overdue rule
 *   of `GET /sales` uses), sales without due date last, then `confirmedAt`,
 *   then `id` (code-unit order).
 * - Fill (owner Q2 «En orden; la última queda parcial»): each sale receives
 *   `min(remaining, its debt)`; the last reached one may stay partial and the
 *   rest receive 0 (they are still listed, with no parts).
 * - Tenders are consumed in request order except cash, which always goes last,
 *   so any excess is cash. One part per (sale, tender) for the APPLIED amount.
 * - Change (owner Q3 «Sí, solo hasta el efectivo entregado»): the excess over
 *   the debt is change only while it does not exceed the cash tendered;
 *   otherwise `COLLECTION_EXCEEDS_DEBT` (there is no customer balance).
 */
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';

export type CollectionTenderMethod =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer';

export interface CollectionCandidate {
  saleId: string;
  dueDate: Date | null;
  confirmedAt: Date | null;
  /** Open debt of the sale; always > 0 for a candidate. */
  debtCents: number;
}

export interface CollectionTender {
  method: CollectionTenderMethod;
  amountCents: number;
}

export interface CollectionAllocationPart {
  /** Index of the tender in the REQUEST order. */
  tenderIndex: number;
  method: CollectionTenderMethod;
  amountCents: number;
}

export interface CollectionSaleAllocation<T extends CollectionCandidate> {
  candidate: T;
  appliedCents: number;
  parts: CollectionAllocationPart[];
}

export interface CollectionAllocation<T extends CollectionCandidate> {
  /** Every candidate, in allocation order (unreached ones with 0). */
  sales: CollectionSaleAllocation<T>[];
  /** Open debt of all the candidates before the collection. */
  debtCents: number;
  tenderedCents: number;
  appliedCents: number;
  changeDueCents: number;
}

/** Due day: the UTC calendar date of the stored `dueDate`. */
function dueDay(dueDate: Date | null): string | null {
  return dueDate ? dueDate.toISOString().slice(0, 10) : null;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Q1 order; returns a new array. */
export function orderCollectionCandidates<T extends CollectionCandidate>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((left, right) => {
    const leftDay = dueDay(left.dueDate);
    const rightDay = dueDay(right.dueDate);
    if (leftDay !== rightDay) {
      if (leftDay === null) return 1;
      if (rightDay === null) return -1;
      return compareText(leftDay, rightDay);
    }
    const leftConfirmed = left.confirmedAt?.getTime() ?? Infinity;
    const rightConfirmed = right.confirmedAt?.getTime() ?? Infinity;
    if (leftConfirmed !== rightConfirmed) {
      return leftConfirmed < rightConfirmed ? -1 : 1;
    }
    return compareText(left.saleId, right.saleId);
  });
}

/**
 * The sales a tender of `tenderedCents` reaches, in Q1 order: the shortest
 * prefix whose debt covers the tender, or every candidate when the tender is
 * at least the whole debt (the change is computed over all of them). These
 * are the only sales a collection without `saleIds` has to lock; the rest
 * receive 0 (contract §3.3).
 */
export function collectionLockPrefix<T extends CollectionCandidate>(
  candidates: readonly T[],
  tenderedCents: number,
): T[] {
  const ordered = orderCollectionCandidates(candidates);
  let covered = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    covered += ordered[index].debtCents;
    if (covered >= tenderedCents) return ordered.slice(0, index + 1);
  }
  return ordered;
}

export function allocateCollection<T extends CollectionCandidate>(
  candidates: readonly T[],
  tenders: readonly CollectionTender[],
): CollectionAllocation<T> {
  for (const tender of tenders) {
    if (!Number.isInteger(tender.amountCents) || tender.amountCents <= 0) {
      throw new BusinessRuleViolationError(
        'PAYMENT_AMOUNT_INVALID',
        'PAYMENT_AMOUNT_INVALID',
      );
    }
  }
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.debtCents) || candidate.debtCents <= 0) {
      throw new Error(
        `collection candidate without open debt: ${candidate.saleId}`,
      );
    }
  }
  if (candidates.length === 0) {
    throw new BusinessRuleViolationError(
      'COLLECTION_NO_OPEN_DEBT',
      'COLLECTION_NO_OPEN_DEBT',
    );
  }

  const ordered = orderCollectionCandidates(candidates);
  const debtCents = sum(ordered.map((c) => c.debtCents));
  const tenderedCents = sum(tenders.map((t) => t.amountCents));
  const cashTenderedCents = sum(
    tenders.filter((t) => t.method === 'cash').map((t) => t.amountCents),
  );
  const excessCents = Math.max(tenderedCents - debtCents, 0);
  if (excessCents > cashTenderedCents) {
    throw new BusinessRuleViolationError(
      'COLLECTION_EXCEEDS_DEBT',
      'COLLECTION_EXCEEDS_DEBT',
    );
  }

  // Consumption queue: non-cash in request order, then cash in request order.
  const queue = tenders
    .map((tender, tenderIndex) => ({
      tenderIndex,
      method: tender.method,
      remaining: tender.amountCents,
    }))
    .sort(
      (left, right) =>
        Number(left.method === 'cash') - Number(right.method === 'cash') ||
        left.tenderIndex - right.tenderIndex,
    );

  let cursor = 0;
  const sales = ordered.map((candidate): CollectionSaleAllocation<T> => {
    const parts: CollectionAllocationPart[] = [];
    let need = candidate.debtCents;
    while (need > 0 && cursor < queue.length) {
      const tender = queue[cursor];
      const take = Math.min(need, tender.remaining);
      parts.push({
        tenderIndex: tender.tenderIndex,
        method: tender.method,
        amountCents: take,
      });
      need -= take;
      tender.remaining -= take;
      if (tender.remaining === 0) cursor += 1;
    }
    return {
      candidate,
      appliedCents: candidate.debtCents - need,
      parts,
    };
  });

  const appliedCents = sum(sales.map((s) => s.appliedCents));
  return {
    sales,
    debtCents,
    tenderedCents,
    appliedCents,
    changeDueCents: tenderedCents - appliedCents,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
