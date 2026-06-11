import { Sale } from './sale.entity';
import type {
  SalesListBaseFilter,
  SalesListExtendedFilter,
} from '../dto/sales-list-filter.types';

export type PersistedChargePayment = {
  method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
  amountCents: number;
  reference?: string;
};

export type PersistedSalePaymentRecord = {
  paymentId: string;
  method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
  amountCents: number;
  reference: string | null;
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

  runInTransaction<T>(work: () => Promise<T>): Promise<T>;

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
  }): Promise<PersistedSalePaymentRecord[]>;

  persistCollectedPayment(input: {
    saleId: string;
    method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
    amountCents: number;
    reference?: string | null;
    userId: string;
  }): Promise<{
    paymentId: string;
    paidCents: number;
    debtCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    totalCents: number;
  }>;

  persistCollectedPayments(input: {
    saleId: string;
    userId: string;
    payments: Array<{
      method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
      amountCents: number;
      reference?: string | null;
    }>;
  }): Promise<{
    paymentIds: string[];
    paidCents: number;
    debtCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    totalCents: number;
  }>;

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
    }>;
    payments: Array<{
      method: string;
      amountCents: number;
      tenderedCents: number;
      changeCents: number;
      reference: string | null;
      paidAt: Date;
      createdAt: Date;
      userId: string | null;
      user: { id: string; name: string } | null;
    }>;
  } | null>;
}

/**
 * Injection token for ISaleRepository
 */
export const SALE_REPOSITORY = Symbol('ISaleRepository');
