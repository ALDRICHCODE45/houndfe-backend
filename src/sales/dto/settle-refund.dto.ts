import {
  IsIn,
  IsInt,
  IsISO8601,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import type { SaleRefundMethod } from '../domain/sale.repository';

/**
 * rfs-3a — runtime mirror of the domain `SaleRefundMethod` union.
 *
 * `satisfies` keeps every literal checked against the domain type, so this
 * request contract can never speak a tender method the domain does not carry.
 */
export const SALE_REFUND_METHODS = [
  'cash',
  'card_credit',
  'card_debit',
  'transfer',
  'credit',
] as const satisfies readonly SaleRefundMethod[];

/** PostgreSQL/Prisma `Int` ceiling — cents can never exceed 2147483647. */
export const MAX_CENTS = 2147483647;

/**
 * rfs-3a — request contract for one partial refund settlement.
 *
 * `settledAt` stays the client-supplied ISO-8601 string: the DTO performs no
 * date transform, so the application layer owns the `Date` conversion and
 * keeps the client's cash-event instant.
 */
export class SettleRefundDto {
  @IsInt()
  @Min(1)
  @Max(MAX_CENTS)
  amountCents: number;

  @IsIn(SALE_REFUND_METHODS)
  method: SaleRefundMethod;

  // Optional but string-only: unlike `UpdateSalePaymentReferenceDto` (whose
  // `null` clears the value), a settlement gains nothing from `null`, so an
  // explicit null is rejected and the service normalizes absence to `null`.
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  reference?: string;

  @IsISO8601()
  settledAt: string;
}
