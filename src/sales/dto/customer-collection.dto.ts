/**
 * customer-collection / T2 (S2, S3) — «Cobrar todo» request and response
 * shapes (contract v1 §2, §6).
 *
 * `cashSessionId` is validated only when present: its absence on the apply
 * route is the domain error `422 CASH_SESSION_REQUIRED` (owner Q7), not a
 * validation 400. The preview ignores the session and the expected debt.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import type { CollectionTenderMethod } from '../domain/collection-allocation';

export const COLLECTION_MAX_TENDERS = 5;
export const COLLECTION_MAX_SALES = 50;
/**
 * PostgreSQL INT4 max: each tender AND their sum (`sale_collections.
 * tenderedCents`, the cash movement) must fit, so an oversized tender is a
 * validation 400 instead of a 500 on the insert.
 */
export const COLLECTION_MAX_TENDERED_CENTS = 2_147_483_647;
/**
 * The single-sale payment DTO has no reference limit; 120 bounds the copy on
 * every per-sale payment row a collection writes.
 */
export const COLLECTION_MAX_REFERENCE_LENGTH = 120;

/** The tendered total fits INT4 (each amount is checked by its own @Max). */
@ValidatorConstraint({ name: 'collectionTenderedTotal', async: false })
class CollectionTenderedTotalConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) return true;
    let total = 0;
    for (const tender of value as Array<{ amountCents?: unknown }>) {
      // A non-integer amount is reported by the tender's own validators.
      if (!Number.isInteger(tender?.amountCents)) return true;
      total += tender.amountCents as number;
    }
    return total <= COLLECTION_MAX_TENDERED_CENTS;
  }

  defaultMessage(): string {
    return 'PAYMENTS_TOTAL_TOO_LARGE';
  }
}

export class CustomerCollectionTenderDto {
  @IsIn(['cash', 'card_credit', 'card_debit', 'transfer'])
  method: CollectionTenderMethod;

  @IsInt()
  @Min(1)
  @Max(COLLECTION_MAX_TENDERED_CENTS)
  amountCents: number;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_MAX_REFERENCE_LENGTH)
  reference?: string;

  @IsOptional()
  @IsUUID('all', { message: 'INVALID_PAYMENT_METHOD_ID' })
  paymentMethodId?: string;
}

/** Preview: 0–5 tenders (0 = just show the debt and the order). */
export class CustomerCollectionPreviewDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(COLLECTION_MAX_TENDERS)
  @ValidateNested({ each: true })
  @Validate(CollectionTenderedTotalConstraint)
  @Type(() => CustomerCollectionTenderDto)
  payments?: CustomerCollectionTenderDto[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(COLLECTION_MAX_SALES)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  saleIds?: string[];

  /** Accepted (same body as the apply route) and ignored by the preview. */
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsUUID('all', { message: 'INVALID_CASH_SESSION_ID' })
  cashSessionId?: string;

  /** Accepted (same body as the apply route) and ignored by the preview. */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedDebtCents?: number;
}

/** Apply: 1–5 tenders. */
export class CreateCustomerCollectionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(COLLECTION_MAX_TENDERS)
  @ValidateNested({ each: true })
  @Validate(CollectionTenderedTotalConstraint)
  @Type(() => CustomerCollectionTenderDto)
  payments: CustomerCollectionTenderDto[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(COLLECTION_MAX_SALES)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  saleIds?: string[];

  // Only omission reaches the service (→ 422 CASH_SESSION_REQUIRED); null or
  // a malformed id is a validation 400.
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsUUID('all', { message: 'INVALID_CASH_SESSION_ID' })
  cashSessionId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedDebtCents?: number;
}

export interface CollectionCatalogSnapshotDto {
  paymentMethodId: string;
  name: string;
  subtitle?: string;
}

export interface CollectionTenderResponseDto {
  method: CollectionTenderMethod;
  /** Tendered amount (cash includes the change). */
  amountCents: number;
  catalog: CollectionCatalogSnapshotDto | null;
}

export interface CollectionSaleResponseDto {
  saleId: string;
  folio: string | null;
  /** Same string as the `GET /sales` row. */
  confirmedAt: string | null;
  /** Same string as the `GET /sales` row. */
  dueDate: string | null;
  /** Handoff 28 rule, BEFORE this collection. */
  overdue: boolean;
  appliedCents: number;
  /** After this collection. */
  paidCents: number;
  debtCents: number;
  paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
}

export interface CollectionPreviewResponseDto {
  customer: { id: string; name: string };
  /** Open debt of the candidate sales before the collection (`expectedDebtCents`). */
  debtCents: number;
  tenderedCents: number;
  appliedCents: number;
  changeDueCents: number;
  payments: CollectionTenderResponseDto[];
  /** Every candidate in allocation order, including `appliedCents: 0`. */
  sales: CollectionSaleResponseDto[];
  remainingCustomerDebtCents: number;
}

export interface CollectionResponseDto {
  collectionId: string;
  customer: { id: string; name: string };
  createdAt: string;
  tenderedCents: number;
  appliedCents: number;
  changeDueCents: number;
  payments: CollectionTenderResponseDto[];
  /** Only the sales that received money, in allocation order. */
  sales: Array<CollectionSaleResponseDto & { paymentIds: string[] }>;
  remainingCustomerDebtCents: number;
}

/**
 * customer-collection / T3 (S5) — one sale of `GET /collections/:id`: the
 * POST sale plus the sale's CURRENT status (`CANCELED` when it was cancelled
 * after the collection). Every other field describes the collection moment
 * (see `CollectionReadService`).
 */
export interface CollectionReadSaleDto extends CollectionSaleResponseDto {
  paymentIds: string[];
  saleStatus: 'CONFIRMED' | 'CANCELED';
}

/**
 * customer-collection / T3 (S5) — `GET /collections/:id`: the POST shape,
 * plus `saleStatus` per sale; `customer` is null once the customer was
 * deleted, and then `remainingCustomerDebtCents` is null too (the customer's
 * other sales can no longer be identified).
 */
export interface CollectionReadResponseDto {
  collectionId: string;
  customer: { id: string; name: string } | null;
  createdAt: string;
  tenderedCents: number;
  appliedCents: number;
  changeDueCents: number;
  payments: CollectionTenderResponseDto[];
  sales: CollectionReadSaleDto[];
  remainingCustomerDebtCents: number | null;
}

/** customer-collection / T3 (S5) — what the «Comprobante de cobro» prints. */
export interface CollectionReceiptDto {
  collection: CollectionReadResponseDto;
  /** Tenant (branch) name. */
  branchName: string;
  /** Name of the cashier who collected (null when the user is gone). */
  cashierName: string | null;
}
