import type { StaffSaleHoldView } from '../domain/sale-hold';
import type { SaleCancelReason } from '../domain/sale.entity';
import type { SaleListItemPreview } from '../domain/sale.repository';
import type { SaleShippingAddressDto } from './sale-shipping-address.dto';

export interface SaleListRowDto {
  id: string;
  folio: string | null;
  status: string;
  /**
   * pay-in-store-pickup / T5 (S7) — sale channel: 'POS' for counter sales,
   * 'ONLINE' for chatbot sales. Always present on the wire (optional only
   * for typing, like `hold`).
   */
  channel?: 'POS' | 'ONLINE';
  /**
   * pay-in-store-pickup / T5 (S7) — why the sale was canceled; null unless
   * canceled (HOLD_EXPIRED = «Apartado vencido»). Always present on the wire.
   */
  cancelReason?: SaleCancelReason | null;
  paymentStatus: string | null;
  deliveryStatus: string;
  totalCents: number;
  debtCents: number;
  confirmedAt: Date | null;
  dueDate: string | null;
  customer: { id: string; name: string } | null;
  cashier: { id: string; name: string };
  seller: { id: string; name: string } | null;
  paymentMethods: string[];
  /** Sale-time shipping snapshot with its source status; null without one. */
  shippingAddress: SaleShippingAddressDto | null;
  /**
   * pay-in-store-pickup / T1 — the counter-payment hold; null unless the bot
   * declared IN_STORE. Always present on the wire (optional only for typing).
   */
  hold?: StaffSaleHoldView | null;
  /**
   * sales-history-redesign S1 (contract §1) — at most 3 lines in creation
   * order (`createdAt`, then `id`), names from the line snapshot.
   */
  itemsPreview: SaleListItemPreview[];
  /** Number of lines of the sale (not units). */
  itemsCount: number;
}

export interface SaleListResponseDto {
  data: SaleListRowDto[];
  /**
   * `total` / `totalPages` count the rows matching EVERY filter that drove
   * `data` (base + extended: status, folio, payment/delivery status,
   * payment method, ranges), so they always agree with the listed rows.
   * They are NOT KPIs and differ from `counts.all` whenever an extended
   * filter narrows the list.
   */
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  /**
   * KPI tab counts over the base filter set only (`q`, cashier, customer,
   * confirmed date range; confirmed sales). Extended filters do not move
   * them, so tabs keep their totals while a tab filter is applied.
   */
  counts: {
    all: number;
    pendingPayments: number;
    notDelivered: number;
    /**
     * sales-history-redesign S3 (contract §7) — overdue sales: CONFIRMED,
     * open debt > 0, due day (the UTC calendar date of `dueDate`, as the POS
     * renders it) before today's local date in the business timezone. Base
     * filters only, like the other counts.
     */
    overdue: number;
  };
  /**
   * Customer sales history — WU backend summary block. Confirmed-only
   * aggregates over the SAME base filters that drove `counts.all` — so
   * `summary.salesCount === counts.all` holds by construction. It equals
   * `pagination.total` only when no extended filter is applied.
   *
   * `totalSoldCents` is the sum of `totalCents` over every confirmed
   * sale in the matched set (NOT paginated rows — see the doc warning).
   * `outstandingDebtCents` is the sum of `debtCents` (rows with no
   * debt contribute zero).
   *
   * Zeroed (not null) when no rows match — Prisma null sums are
   * normalized on the adapter path.
   */
  summary: {
    salesCount: number;
    totalSoldCents: number;
    outstandingDebtCents: number;
    /** S2 — `round(totalSoldCents / salesCount)` (half up), 0 when no sale. */
    averageTicketCents: number;
    /** S3 — open debt of the overdue sales (`counts.overdue`). */
    overdueDebtCents: number;
    /** S3 — UTC calendar date (`YYYY-MM-DD`) of the oldest overdue `dueDate`, or null. */
    oldestOverdueDueDate: string | null;
  };
  /**
   * Totals over EVERY row matching the same filters as `data` (base +
   * extended, same tenant/permission scope), not just the page.
   * `count === pagination.total`. `totalCents` sums `totalCents` (canceled
   * sales included when the status filter includes them). `debtCents` sums
   * the open debt: canceled sales count as 0. Zeroed (not null) when no
   * rows match. Unlike `summary`, extended filters DO move these values.
   */
  filterSummary: {
    count: number;
    totalCents: number;
    debtCents: number;
  };
}
