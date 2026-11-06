import {
  ArrayMinSize,
  IsArray,
  IsIn,
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
import { Type, type TypeHelpOptions } from 'class-transformer';

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

/**
 * DEPRECATED (shipping-zones / T7): per-charge human approval. Kept working,
 * with the same validations, until the chatbot migrates to `{ quoteId }` /
 * `{ mode: "pickup" }` (docs/chatbot-checkout-shipping.md).
 */
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

/** shipping-zones / T7 (S8) — a backend quote from POST /chatbot-api/shipping/quotes. */
export class QuoteBotSaleShippingDto {
  @IsString()
  @MaxLength(200)
  @Matches(/\S/)
  quoteId!: string;
}

/** shipping-zones / T7 (S10) — store pickup: no address, no shipping charge. */
export class PickupBotSaleShippingDto {
  @IsIn(['pickup'])
  mode!: 'pickup';
}

export type BotSaleShipping =
  | BotSaleShippingDto
  | QuoteBotSaleShippingDto
  | PickupBotSaleShippingDto;

/**
 * Picks the shipping shape by its keys: `mode` → pickup; `chargeCents` or
 * `approvalId` → legacy approved charge; otherwise → quote. Unknown keys of
 * the picked shape are then rejected by `forbidNonWhitelisted`, so mixed
 * shapes (`{ mode: "pickup", quoteId }`) fail with 400.
 */
export function botSaleShippingType(options?: TypeHelpOptions) {
  const raw: unknown =
    options?.object && options.property
      ? (options.object as Record<string, unknown>)[options.property]
      : undefined;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if ('mode' in raw) return PickupBotSaleShippingDto;
    if ('chargeCents' in raw || 'approvalId' in raw) return BotSaleShippingDto;
  }
  return QuoteBotSaleShippingDto;
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

  // shipping-zones / T7 — `{ quoteId }` | `{ mode: "pickup" }`; the legacy
  // `{ chargeCents, approvalId, quoteId? }` keeps its owner-configured ceiling.
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(botSaleShippingType)
  shipping?: BotSaleShipping;
}
