import { Sale } from './sale.entity';

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
    method: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';
    amountCents: number;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    paidCents: number;
    debtCents: number;
    changeDueCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    channel?: 'POS' | 'ONLINE';
    register?: string;
    deliveryStatus?: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE';
    customerId?: string | null;
    sellerUserId?: string | null;
    confirmedAt: Date;
    folio: string;
  }): Promise<void>;

  persistCollectedPayment(input: {
    saleId: string;
    method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
    amountCents: number;
    reference?: string | null;
  }): Promise<{
    paidCents: number;
    debtCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    totalCents: number;
  }>;

  findManyConfirmed(input: {
    page: number;
    limit: number;
    sortBy: 'confirmedAt' | 'totalCents' | 'createdAt';
    sortOrder: 'asc' | 'desc';
    q?: string;
    status?: 'DRAFT' | 'CONFIRMED' | 'CANCELED';
    paymentStatus?: 'PAID' | 'PARTIAL' | 'CREDIT';
    deliveryStatus?: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE';
    from?: Date;
    to?: Date;
    cashierUserId?: string;
    customerId?: string;
  }): Promise<
    Array<{
      id: string;
      folio: string | null;
      status: string;
      paymentStatus: string | null;
      deliveryStatus: string;
      totalCents: number;
      debtCents: number;
      confirmedAt: Date | null;
      customer: { id: string; name: string } | null;
      cashier: { id: string; name: string };
      seller: { id: string; name: string } | null;
    }>
  >;

  countConfirmed(input: {
    q?: string;
    from?: Date;
    to?: Date;
    cashierUserId?: string;
    customerId?: string;
  }): Promise<number>;

  groupByPaymentStatusConfirmed(input: {
    q?: string;
    from?: Date;
    to?: Date;
    cashierUserId?: string;
    customerId?: string;
  }): Promise<Array<{ paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null; _count: { _all: number } }>>;

  countNotDeliveredConfirmed(input: {
    q?: string;
    from?: Date;
    to?: Date;
    cashierUserId?: string;
    customerId?: string;
  }): Promise<number>;

  findOneWithRelations(id: string): Promise<{
    id: string;
    folio: string | null;
    status: string;
    channel: 'POS' | 'ONLINE';
    register: string;
    confirmedAt: Date | null;
    createdAt: Date;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    paidCents: number;
    debtCents: number;
    changeDueCents: number;
    paymentStatus: string | null;
    deliveryStatus: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE';
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
    }>;
    payments: Array<{
      method: string;
      amountCents: number;
      tenderedCents: number;
      changeCents: number;
      reference: string | null;
      paidAt: Date;
      createdAt: Date;
    }>;
  } | null>;
}

/**
 * Injection token for ISaleRepository
 */
export const SALE_REPOSITORY = Symbol('ISaleRepository');
