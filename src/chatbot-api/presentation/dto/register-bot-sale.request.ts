import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateIf,
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

export class BotSaleShippingDto {
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  chargeCents!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/\S/)
  approvalId!: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/\S/)
  quoteId?: string;
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
   * omitted on a legacy sale, the server still runs the engine and
   * persists totals. Required whenever `shipping` is present.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTotalCents?: number;

  // Recognize and validate shipping, but reject it until receipt views
  // reconcile and an owner-configured charge ceiling enables the feature.
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => BotSaleShippingDto)
  shipping?: BotSaleShippingDto;
}
