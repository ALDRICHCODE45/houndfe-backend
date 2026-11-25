/**
 * sales-history-redesign S11 — read port of the customer statement: ONE
 * consistent, tenant-scoped snapshot (customer, period sales, every open-debt
 * sale, period payments). Business rules (overdue, totals, labels) live in
 * `CustomerStatementService`, not in the reader.
 */
export const CUSTOMER_STATEMENT_READER = Symbol('CUSTOMER_STATEMENT_READER');

export interface CustomerStatementRange {
  /** Inclusive local date `YYYY-MM-DD`. */
  from: string;
  /** Exclusive local date `YYYY-MM-DD`. */
  to: string;
  /** IANA zone the local dates are interpreted in. */
  timeZone: string;
}

export interface CustomerStatementSnapshot {
  /** Tenant (branch) name. */
  branchName: string;
  customer: {
    id: string;
    firstName: string;
    lastName: string | null;
    phoneCountryCode: string | null;
    phone: string | null;
    email: string | null;
    rfc: string | null;
    businessName: string | null;
  };
  /** CONFIRMED sales of the customer with `confirmedAt` in the local range. */
  periodSales: Array<{
    id: string;
    folio: string | null;
    confirmedAt: Date;
    localDate: string;
    totalCents: number;
    paidCents: number;
    openDebtCents: number;
    dueDate: Date | null;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
  }>;
  /** Every CONFIRMED sale of the customer with `openDebtCents > 0`. */
  openDebtSales: Array<{
    id: string;
    dueDate: Date | null;
    openDebtCents: number;
  }>;
  /** Payment rows of the customer's sales created in the local range. */
  payments: Array<{
    id: string;
    saleId: string;
    saleFolio: string | null;
    saleStatus: string;
    /** Sale-level change returned at the charge (`changeDueCents`). */
    saleChangeDueCents: number;
    paidAt: Date;
    localDate: string;
    method: string;
    amountCents: number;
    /** `metadataJson.catalog.name` snapshot, when a catalog method was used. */
    catalogName: string | null;
  }>;
}

export interface ICustomerStatementReader {
  /** `null` when the customer does not exist in the current tenant. */
  read(
    customerId: string,
    range: CustomerStatementRange,
  ): Promise<CustomerStatementSnapshot | null>;
}
