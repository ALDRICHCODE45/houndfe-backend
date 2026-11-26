import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type {
  CollectionCatalogSnapshotDto,
  CollectionTenderResponseDto,
} from './customer-collection.dto';

export const CUSTOMER_PAYMENTS_DEFAULT_LIMIT = 50;
export const CUSTOMER_PAYMENTS_MAX_LIMIT = 100;

/**
 * customers-listing T2 (S5, contract §7) — `GET /customers/:customerId/
 * payments?page=&limit=`: `page` ≥ 1 (default 1), `limit` 1–100 (default
 * 50, the customers table default).
 */
export class CustomerPaymentsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CUSTOMER_PAYMENTS_MAX_LIMIT)
  limit: number = CUSTOMER_PAYMENTS_DEFAULT_LIMIT;
}

/** Lowercase in both event kinds (frontend L2.3), as in `GET /collections/:id`. */
export type CustomerPaymentMethod =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer';

/** `User.name` of the actor; null when unknown or deleted. */
export interface CustomerPaymentCashierDto {
  id: string;
  name: string;
}

/** One «Cobrar todo» (`sale_collections` row) of the customer. */
export interface CustomerCollectionEventDto {
  kind: 'collection';
  /** The collection id. */
  eventId: string;
  /** `sale_collections.createdAt`. */
  occurredAt: string;
  /** `appliedCents`: the money kept by the sales. */
  amountCents: number;
  tenderedCents: number;
  changeDueCents: number;
  /** The stored tenders, same parser and shape as `GET /collections/:id`. */
  payments: CollectionTenderResponseDto[];
  /** Sales that received money, in the `GET /collections/:id` order. */
  sales: Array<{
    saleId: string;
    folio: string | null;
    /** CURRENT status of the sale. */
    status: string;
    appliedCents: number;
  }>;
  cashier: CustomerPaymentCashierDto | null;
  /** `/collections/:id/pdf` — the frontend appends `?format=ticket|a4`. */
  receiptPath: string;
}

/** Any other `sale_payments` row of the customer. */
export interface CustomerPaymentEventDto {
  kind: 'payment';
  /** The `sale_payments` id. */
  eventId: string;
  /** `sale_payments.createdAt`. */
  occurredAt: string;
  method: CustomerPaymentMethod;
  /** `metadataJson.catalog` when valid, else null. */
  catalog: CollectionCatalogSnapshotDto | null;
  reference: string | null;
  /** `tenderedCents − changeCents` (the statement PDF amount). */
  amountCents: number;
  /** Stored amount. */
  tenderedCents: number;
  /** This row's share of the sale's `changeDueCents` (statement rule). */
  changeCents: number;
  sale: {
    id: string;
    folio: string | null;
    /** CURRENT status of the sale (`CANCELED` when canceled later). */
    status: string;
    totalCents: number;
  };
  cashier: CustomerPaymentCashierDto | null;
  /**
   * `/sales/:id/pdf` — the frontend appends `?format=receipt-a4|receipt-ticket`;
   * null when the sale is not CONFIRMED (the PDF would answer 400).
   */
  receiptPath: string | null;
}

export type CustomerPaymentsEventDto =
  | CustomerCollectionEventDto
  | CustomerPaymentEventDto;

export interface CustomerPaymentsResponseDto {
  /** Newest first: `occurredAt desc, eventId desc`. */
  data: CustomerPaymentsEventDto[];
  /** Same object as `GET /sales`; `total` counts events. */
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
