/**
 * customer-collection / T2 — reads and the one insert of a «Cobrar todo»
 * (contract v1 §3, §5). The per-sale payment writes reuse
 * `ISaleRepository.persistCollectedPayments`.
 *
 * Lock order of the collection transaction (after the cash session fence):
 * customer row `FOR KEY SHARE` → sales `FOR UPDATE ORDER BY id` (the
 * selection, or without one only the sales the tender reaches, read first
 * without locks through `findOpenDebtSales` and locked by `findSalesByIds`).
 * Customer DELETE takes customer `FOR UPDATE` → the customer's sales `ORDER BY
 * id`, and the single-sale payment locks one sale, so none of them can wait
 * on each other in a cycle.
 */
export const CUSTOMER_COLLECTION_REPOSITORY = Symbol(
  'CUSTOMER_COLLECTION_REPOSITORY',
);

export interface CollectionCustomer {
  id: string;
  /** `firstName lastName` (or `firstName`), as the `GET /sales` row renders it. */
  name: string;
}

export interface CollectionSaleRow {
  saleId: string;
  customerId: string | null;
  status: string;
  folio: string | null;
  confirmedAt: Date | null;
  dueDate: Date | null;
  totalCents: number;
  paidCents: number;
  /** Open debt (`openDebtCents`: 0 when CANCELED). */
  debtCents: number;
  paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
}

export interface ICustomerCollectionRepository {
  /** Tenant-scoped; `lock` takes `FOR KEY SHARE` on the customer row. */
  findCustomer(
    customerId: string,
    options: { lock: boolean },
  ): Promise<CollectionCustomer | null>;

  /** CONFIRMED sales of the customer with open debt; `lock` = `FOR UPDATE ORDER BY id`. */
  findOpenDebtSales(
    customerId: string,
    options: { lock: boolean },
  ): Promise<CollectionSaleRow[]>;

  /** The tenant's sales among `saleIds` (any customer/status); same lock. */
  findSalesByIds(
    saleIds: readonly string[],
    options: { lock: boolean },
  ): Promise<CollectionSaleRow[]>;

  /** Open debt of every CONFIRMED sale of the customer. */
  sumOpenDebt(customerId: string): Promise<number>;

  insertCollection(input: {
    id: string;
    customerId: string;
    actorUserId: string;
    cashSessionId: string;
    tenderedCents: number;
    appliedCents: number;
    changeDueCents: number;
    tendersJson: unknown;
  }): Promise<{ createdAt: Date }>;
}
