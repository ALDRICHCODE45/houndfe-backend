import type { SaleCancelReason } from '../domain/sale.entity';
import type { SaleRefundMethod } from '../domain/sale.repository';

/**
 * pending-refund-obligations / prf-3 — application read projection for
 * one PENDING refund obligation.
 *
 * The projection is declared here (instead of re-exporting the domain
 * record) so the response shape is reviewed as a public contract and
 * cannot silently widen when the domain read record changes. It is
 * structurally identical to `PendingSaleRefundRecord`, which is what
 * lets the repository rows flow through without a mapping layer.
 *
 * `status` is pinned to the literal `'PENDING'`: the repository filters
 * on that status, so every returned row carries it by construction and
 * `outstandingCents` exposes `amountCents - settledCents`.
 */
export interface PendingRefundRowDto {
  id: string;
  saleId: string;
  method: SaleRefundMethod;
  amountCents: number;
  settledCents: number;
  outstandingCents: number;
  reason: SaleCancelReason;
  status: 'PENDING';
  createdAt: Date;
}

/**
 * pending-refund-obligations / prf-3 — paginated application envelope,
 * matching the `{ data, pagination }` shape of the neighboring sales
 * list.
 *
 * An empty result is a successful empty page (`data: []`, `total: 0`,
 * `totalPages: 0`), never a 404: "no pending obligations" is a normal
 * read state of the collection, not a missing resource.
 */
export interface PendingRefundListResponseDto {
  data: PendingRefundRowDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
