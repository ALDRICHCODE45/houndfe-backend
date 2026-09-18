import { Sale } from './sale.entity';
import { SaleItem } from './sale-item.entity';
import type { AppliedOrderPromotionSnapshot } from './sale.entity';
import type {
  SalesListBaseFilter,
  SalesListExtendedFilter,
} from '../dto/sales-list-filter.types';
import type { Prisma } from '@prisma/client';

export type PersistedChargePayment = {
  method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
  amountCents: number;
  reference?: string;
  // Custom Payment Methods (custom-payment-methods / WU2 — D7): the
  // sales service attaches a `metadataJson` snapshot under the
  // dedicated `catalog` key when an entry carried a `paymentMethodId`.
  // The adapter writes `undefined → Prisma.JsonNull` exactly like
  // `persistCollectedPayments` so legacy charge rows stay absent on
  // the wire.
  metadataJson?: unknown;
};

export type PersistedSalePaymentRecord = {
  paymentId: string;
  method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
  amountCents: number;
  reference: string | null;
};

export type PersistedSaleRefundRecord = {
  salePaymentId: string | null;
  method: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';
  amountCents: number;
  reason: NonNullable<ReturnType<Sale['toResponse']>['cancelReason']>;
};

export type DraftCustomerSummary = {
  id: string;
  firstName: string;
  lastName: string | null;
};

export type DraftShippingAddressSummary = {
  id: string;
  street: string | null;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
};

export type DraftSaleResponse = ReturnType<Sale['toResponse']> & {
  customer: DraftCustomerSummary | null;
  shippingAddress: DraftShippingAddressSummary | null;
};

/**
 * delivery-routes / WU2 + ODD O1 — outcome of the tenant-qualified
 * CONDITIONAL `markSaleDelivered` transition. See the port method doc for
 * the semantics carried by each variant.
 */
export type MarkSaleDeliveredOutcome =
  | { kind: 'delivered' }
  | { kind: 'not_deliverable' }
  | { kind: 'missing' };

/**
 * Sale Repository Port - defines persistence operations for Sales
 *
 * This is a port (interface) in hexagonal architecture.
 * Concrete implementation (adapter) will be in infrastructure layer.
 */
export interface ISaleRepository {
  /**
   * Save a sale (create or update)
   */
  save(sale: Sale): Promise<Sale>;

  saveDraftItems(sale: Sale): Promise<Sale>;

  /**
   * Find sale by ID
   */
  findById(id: string): Promise<Sale | null>;

  findDraftResponseById(id: string): Promise<DraftSaleResponse | null>;

  /**
   * Find all DRAFT sales owned by a user
   */
  findDraftsByUserId(userId: string): Promise<Sale[]>;

  /**
   * Delete a sale by ID
   */
  delete(id: string): Promise<void>;

  /**
   * Find a sale by id and lock it for charge transaction.
   */
  findByIdForUpdate(id: string): Promise<Sale | null>;

  acquireChargeIdempotency(
    saleId: string,
    key: string,
    requestHash: string,
  ): Promise<
    | { kind: 'acquired'; token: string }
    | { kind: 'replay'; payload: unknown }
    | { kind: 'conflict' }
    | { kind: 'in_flight' }
  >;

  markChargeIdempotencySucceeded(
    token: string,
    saleId: string,
    payload: unknown,
  ): Promise<void>;

  acquirePaymentIdempotency(
    saleId: string,
    key: string,
    requestHash: string,
  ): Promise<
    | { kind: 'acquired'; token: string }
    | { kind: 'replay'; payload: unknown }
    | { kind: 'conflict' }
    | { kind: 'in_flight' }
  >;

  markPaymentIdempotencySucceeded(
    token: string,
    saleId: string,
    payload: unknown,
  ): Promise<void>;

  acquireCancellationIdempotency(
    saleId: string,
    key: string,
    requestHash: string,
  ): Promise<
    | { kind: 'acquired'; token: string }
    | { kind: 'replay'; payload: unknown }
    | { kind: 'conflict' }
    | { kind: 'in_flight' }
  >;

  markCancellationIdempotencySucceeded(
    token: string,
    saleId: string,
    payload: unknown,
  ): Promise<void>;

  /**
   * Q3 / WU2 — Bot sale registration idempotency. Reserves the
   * `SaleIdempotency` slot atomically for `operation='bot_sale_register'`
   * (D8). Unlike the charge/payment/cancel variants, the `saleId` is
   * `null` at acquire time and only filled by
   * `markSaleRegistrationIdempotencySucceeded` after `confirmBotSale`
   * produces the real sale id.
   *
   * Returns the same four-outcome discriminated union as the other
   * idempotency acquire methods — `replay` (caller returns the cached
   * `BotSaleResponse`), `conflict` (caller throws
   * `IDEMPOTENCY_KEY_CONFLICT`, 409), `in_flight` (caller throws
   * `IDEMPOTENCY_KEY_IN_FLIGHT`, 409), `acquired` (caller proceeds to
   * `confirmBotSale` and stamps SUCCEEDED).
   */
  acquireSaleRegistrationIdempotency(
    key: string,
    requestHash: string,
  ): Promise<
    | { kind: 'acquired'; token: string }
    | { kind: 'replay'; payload: unknown }
    | { kind: 'conflict' }
    | { kind: 'in_flight' }
  >;

  markSaleRegistrationIdempotencySucceeded(
    token: string,
    saleId: string,
    payload: unknown,
  ): Promise<void>;

  runInTransaction<T>(work: () => Promise<T>): Promise<T>;

  /**
   * delivery-routes / WU2 + ODD O1 — Narrow, tenant-qualified CONDITIONAL
   * transition for the route flow's `Sale.deliveryStatus='DELIVERED'` mirror
   * write (design ADR-3).
   *
   * Runs inside the caller-supplied `tx` (the route check-in passes the same
   * client it uses for the stop update, so both commit — or roll back —
   * atomically) and re-evaluates the persisted sale lifecycle IN THE
   * PREDICATE instead of trusting a caller-side pre-read:
   *
   * ```
   * tx.sale.updateMany({
   *   where: { id, tenantId, status: 'CONFIRMED',
   *            deliveryStatus: { in: ['PENDING', 'SHIPPED', 'DELIVERED'] } },
   *   data: { deliveryStatus: 'DELIVERED' },
   * })
   * ```
   *
   * A concurrent cancellation that committed first therefore loses: the
   * predicate no longer matches and NO row is written. `tenantId` is
   * required in the `where` clause as defense in depth on top of the
   * `TenantPrismaService` CLS-injection, so a cross-tenant sale can never be
   * mutated even if a future tenant-scoping regression sneaks past the
   * allowlist.
   *
   * Already-`DELIVERED` sales stay inside the predicate so a completed-stop
   * replay remains a successful, idempotent write. `NOT_APPLICABLE` is
   * deliberately EXCLUDED: that state means the delivery-routes flow does
   * not own the sale's delivery lifecycle.
   *
   * A conditional miss is classified with one explicit `{ id, tenantId }`
   * read on the SAME `tx`, so a missing sale and another tenant's sale are
   * indistinguishable to the caller (no tenant-existence disclosure):
   *   - `{ kind: 'delivered' }` — the conditional write matched (fresh flip
   *     or already-delivered replay).
   *   - `{ kind: 'not_deliverable' }` — the sale exists in the caller's
   *     tenant but its persisted lifecycle forbids the flip (e.g. CANCELED,
   *     or `deliveryStatus='NOT_APPLICABLE'`). The caller maps this to
   *     `SaleNotDeliverableError` (HTTP 422).
   *   - `{ kind: 'missing' }` — no `{ id, tenantId }` match (missing or
   *     foreign). The caller maps this to its own 404 contract.
   */
  markSaleDelivered(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; saleId: string },
  ): Promise<MarkSaleDeliveredOutcome>;

  allocateNextFolio(now?: Date): Promise<string>;

  persistChargeConfirmation(input: {
    saleId: string;
    userId: string;
    payments: PersistedChargePayment[];
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    paidCents: number;
    debtCents: number;
    changeDueCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    channel?: 'POS' | 'ONLINE';
    register?: string;
    deliveryStatus?: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE' | 'SHIPPED';
    customerId?: string | null;
    sellerUserId?: string | null;
    dueDate?: Date | null;
    confirmedAt: Date;
    folio: string;
    /**
     * Work Unit 5 — W1 fix. When provided, the SaleItem rows are
     * deleteMany + createMany-re-written INSIDE the charge tx so the
     * charge-time recomputed per-line promo state (promotionId /
     * discountAmountCents / unitPriceCents) is persisted alongside the
     * charged total. Same pattern as `save`. When omitted, no item re-write
     * happens (back-compat for non-promo charges).
     */
    items?: ReadonlyArray<SaleItem>;
    /**
     * Work Unit 5 — C2 audit. When provided (incl. explicit null), the
     * `sale_promotion_applied` row is upserted (non-null) or deleted
     * (null). When omitted entirely, the table is left alone (back-compat).
     */
    appliedOrderPromotion?: AppliedOrderPromotionSnapshot | null;
  }): Promise<PersistedSalePaymentRecord[]>;

  persistCancellation(
    sale: Sale,
    refunds: PersistedSaleRefundRecord[],
  ): Promise<void>;

  persistCollectedPayment(input: {
    saleId: string;
    method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
    amountCents: number;
    reference?: string | null;
    userId: string | null;
    metadataJson?: unknown;
  }): Promise<{
    paymentId: string;
    paidCents: number;
    debtCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    totalCents: number;
  }>;

  persistCollectedPayments(input: {
    saleId: string;
    userId: string | null;
    payments: Array<{
      method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
      amountCents: number;
      reference?: string | null;
      metadataJson?: unknown;
    }>;
  }): Promise<{
    paymentIds: string[];
    paidCents: number;
    debtCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    totalCents: number;
  }>;

  updatePaymentReference(input: {
    saleId: string;
    paymentId: string;
    reference: string | null;
  }): Promise<{
    paymentId: string;
    method: string;
    amountCents: number;
    reference: string | null;
    paidAt: Date;
  } | null>;

  findManyConfirmed(
    input: SalesListExtendedFilter & {
      page: number;
      limit: number;
      sortBy: 'confirmedAt' | 'totalCents' | 'createdAt';
      sortOrder: 'asc' | 'desc';
    },
  ): Promise<
    Array<{
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
    }>
  >;

  countConfirmed(input: SalesListBaseFilter): Promise<number>;

  /**
   * Customer sales history — WU backend summary block. Single Prisma
   * `aggregate` call replaces the dedicated `countConfirmed` query for
   * the GET /sales summary block: returns `salesCount` (`_count._all`)
   * + `totalSoldCents` (`_sum.totalCents`) + `outstandingDebtCents`
   * (`_sum.debtCents`) in one DB roundtrip — no extra DB query added.
   *
   * Same base filters as `countConfirmed` (confirmed-only, customerId
   * honored, etc.) so `summary.salesCount === counts.all ===
   * pagination.total` holds by construction.
   *
   * The adapter MUST normalize Prisma's null sums (empty match) to 0
   * before returning so the wire shape is `number` (never null).
   */
  aggregateSummaryConfirmed(input: SalesListBaseFilter): Promise<{
    salesCount: number;
    totalSoldCents: number;
    outstandingDebtCents: number;
  }>;

  groupByPaymentStatusConfirmed(input: SalesListBaseFilter): Promise<
    Array<{
      paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
      _count: { _all: number };
    }>
  >;

  countNotDeliveredConfirmed(input: SalesListBaseFilter): Promise<number>;

  findOneWithRelations(id: string): Promise<{
    id: string;
    folio: string | null;
    status: string;
    channel: 'POS' | 'ONLINE';
    register: string;
    confirmedAt: Date | null;
    dueDate: Date | null;
    createdAt: Date;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    paidCents: number;
    debtCents: number;
    changeDueCents: number;
    paymentStatus: string | null;
    deliveryStatus: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE' | 'SHIPPED';
    customer: { id: string; name: string } | null;
    cashier: { id: string; name: string };
    seller: { id: string; name: string } | null;
    items: Array<{
      productName: string;
      variantName: string | null;
      imageUrl: string | null;
      unitPriceCents: number;
      quantity: number;
      discountCents: number;
      subtotalCents: number;
      originalPriceCents: number | null;
      priceSource: 'default' | 'price_list' | 'custom' | null;
      appliedPriceListId: string | null;
      discountType: 'amount' | 'percentage' | null;
      discountValue: number | null;
      discountAmountCents: number | null;
      discountTitle: string | null;
      prePriceCentsBeforeDiscount: number | null;
      // WU7 — D4 wire discriminator. Slice 1 had `rewardKind: 'buy_x_get_y'
      // | null`; WU7 widens to `| 'advanced'` (the new persisted kind).
      // CRITICAL: the port type MUST carry the new value so the mapper's
      // return type matches the interface (a prior identical change in WU3
      // broke the build with TS2322 by omitting the shared field here).
      rewardKind: 'buy_x_get_y' | 'advanced' | null;
      /**
       * WU3 — exact BXGY reward percent (0..100), persisted verbatim. Null
       * on non-reward lines (same `isBxgy` guard as `rewardKind`). CRITICAL:
       * the port type MUST carry this so the mapper's return type matches the
       * DTO (a prior identical change broke the build with TS2322 by omitting
       * the shared field here).
       */
      rewardDiscountPercent: number | null;
      /**
       * WUA — promotionId of the line's promo source (or null when no
       * promotion was applied). Mirrors `SaleDetailItemDto.promotionId`
       * on the wire. The value was already selected by the mapper for
       * the BXGY discriminator — we're just promoting it to the wire.
       */
      promotionId: string | null;
    }>;
    payments: Array<{
      paymentId: string;
      method: string;
      amountCents: number;
      tenderedCents: number;
      changeCents: number;
      reference: string | null;
      paidAt: Date;
      createdAt: Date;
      userId: string | null;
      user: { id: string; name: string } | null;
      // Custom Payment Methods (custom-payment-methods / WU2 — D10):
      // optional branded identity surfaced from `metadataJson.catalog`.
      // Null on legacy rows (no `catalog` key); the mapper MUST default
      // to null when the snapshot is absent so `getSaleDetail` can omit
      // the wire fields on legacy rows. Payment method id is opaque
      // (no live FK).
      paymentMethodId: string | null;
      paymentMethodName: string | null;
      paymentMethodSubtitle: string | null;
    }>;
  } | null>;
}

/**
 * Injection token for ISaleRepository
 */
export const SALE_REPOSITORY = Symbol('ISaleRepository');
