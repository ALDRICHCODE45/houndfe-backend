import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class ChargePaymentEntryDto {
  @IsIn(['cash', 'card_credit', 'card_debit', 'transfer', 'credit'])
  method: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';

  @IsInt()
  @Min(0)
  amountCents: number;

  @IsOptional()
  @IsString()
  reference?: string;

  // Custom Payment Methods (custom-payment-methods / WU2) — optional
  // catalog reference. When present, the sales service resolves the
  // row via `IPaymentMethodResolver.resolveActive()` and snapshots
  // `{ paymentMethodId, name, subtitle? }` under `metadataJson.catalog`.
  // When absent, the row carries no `catalog` key and the legacy path
  // (D5) is byte-identical to pre-change behavior.
  @IsOptional()
  @IsUUID('all', { message: 'INVALID_PAYMENT_METHOD_ID' })
  paymentMethodId?: string;
}

export class ChargeSaleDto {
  @IsOptional()
  @IsIn(['cash', 'card_credit', 'card_debit', 'transfer', 'credit'])
  method?: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';

  @IsOptional()
  @IsInt()
  @Min(0)
  amountCents?: number;

  // Optional single-payment catalog reference — mirrors the per-entry
  // `paymentMethodId` on the `payments[]` branch. The legacy
  // `method + amountCents` shape continues to work without it.
  @IsOptional()
  @IsUUID('all', { message: 'INVALID_PAYMENT_METHOD_ID' })
  paymentMethodId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ChargePaymentEntryDto)
  payments?: ChargePaymentEntryDto[];

  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  // pos-sale-delivery — POS cashier flag to confirm the sale as
  // `deliveryStatus: 'PENDING'` (route-eligible) instead of inheriting the
  // draft's `'DELIVERED'`. Omitted / `undefined` / `false` reproduce today's
  // behavior; a non-boolean is rejected at the DTO layer with a 400
  // class-validator error. Non-null `shippingAddressId` is required for
  // `true` and is enforced by `Sale.markForDelivery()` (`sale.entity.ts`).
  @IsOptional()
  @IsBoolean()
  delivery?: boolean;
}