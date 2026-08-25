import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BotSaleItemDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  @IsOptional()
  variantId?: string | null;

  @IsString()
  @IsNotEmpty()
  productName!: string;

  @IsString()
  @IsOptional()
  variantName?: string | null;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsInt()
  @Min(0)
  unitPriceCents!: number;
}

export class RegisterBotSaleRequestDto {
  /** ID of the POS user acting as cashier for this bot-created order. */
  @IsUUID()
  cashierUserId!: string;

  @IsUUID()
  customerId!: string;

  @IsUUID()
  @IsOptional()
  shippingAddressId?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BotSaleItemDto)
  items!: BotSaleItemDto[];

  /**
   * Q2 / WU3 — Optional re-quote check. When present, the server
   * compares this expected total against the engine-recomputed
   * `totalCents` (D7). A mismatch raises `PROMO_RE_QUOTE` (409) with
   * `{ recomputedTotalCents, expectedTotalCents, discountCents }` so
   * the bot can re-quote with the real totals and re-issue. When
   * omitted, the server still runs the engine and persists the
   * recomputed totals; only the comparison is skipped.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTotalCents?: number;
}
