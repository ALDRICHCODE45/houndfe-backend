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
}

export interface SaleListResponseDto {
  data: SaleListRowDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  counts: {
    all: number;
    pendingPayments: number;
    notDelivered: number;
  };
  /**
   * Customer sales history — WU backend summary block. Confirmed-only
   * aggregates over the SAME base filters that drove `pagination.total`
   * and `counts.all` — so `summary.salesCount === counts.all ===
   * pagination.total` holds by construction.
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
