import type { SaleShippingAddressDto } from './sale-shipping-address.dto';

export interface SaleListRowDto {
  id: string;
  folio: string | null;
  status: string;
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
  };
}
