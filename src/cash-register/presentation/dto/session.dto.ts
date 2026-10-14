/**
 * DTOs: cash-session lifecycle commands (T3/S2,S4,S5,S6,S8).
 *
 * One explicit route per operation; the command discriminant is chosen by the
 * controller, never by the client. All monetary fields are integer cents in the
 * persisted `Int` window. `openingConfirmed` must be literally `true` — a
 * merely boolean `false` (or a string) is rejected because a new session may
 * only start on top of explicitly confirmed opening funds (S5).
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CASH_CENTS_MAX,
  CASH_CHANNEL_KEY_MAX_LENGTH,
  CASH_COUNT_LINES_MAX,
  CASH_DENOMINATIONS_MAX,
  CASH_NOTES_MAX_LENGTH,
  CASH_REASON_MAX_LENGTH,
  IsCashOptional,
  TrimString,
} from './cash-dto.shared';

export class OpenSessionDto {
  @IsInt()
  @Min(0)
  @Max(CASH_CENTS_MAX)
  openingCents!: number;

  /** Optional FLOAT handover that physically funds the opening drawer. */
  @IsCashOptional()
  @IsUUID()
  openingHandoverId?: string;

  /** Must be exactly `true`; accepting `false` would be a custody bypass. */
  @IsBoolean()
  @Equals(true)
  openingConfirmed!: boolean;
}

export class CashCountLineDto {
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CASH_CHANNEL_KEY_MAX_LENGTH)
  channelKey!: string;

  @IsInt()
  @Min(0)
  @Max(CASH_CENTS_MAX)
  amountCents!: number;
}

export class CashDenominationLineDto {
  @IsInt()
  @Min(1)
  @Max(CASH_CENTS_MAX)
  denominationCents!: number;

  @IsInt()
  @Min(0)
  @Max(CASH_CENTS_MAX)
  quantity!: number;
}

/**
 * Blind count body shared by the declaration and verification routes. An empty
 * `lines` array is rejected (an empty count is not a zero count, S4); the
 * client cannot send expected/difference values — those are computed by the
 * application after the first declaration is persisted.
 */
export class CashCountDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CASH_COUNT_LINES_MAX)
  @ValidateNested({ each: true })
  @Type(() => CashCountLineDto)
  lines!: CashCountLineDto[];

  @IsCashOptional()
  @IsArray()
  @ArrayMaxSize(CASH_DENOMINATIONS_MAX)
  @ValidateNested({ each: true })
  @Type(() => CashDenominationLineDto)
  denominations?: CashDenominationLineDto[];

  @IsCashOptional()
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CASH_NOTES_MAX_LENGTH)
  notes?: string;
}

/** Post-submission discrepancy explanation (immutable notes revision). */
export class AnnotateDeclarationDto {
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CASH_NOTES_MAX_LENGTH)
  notes!: string;
}

/** Manual drawer movement (cash-in / cash-out). Amount must be positive. */
export class CashMovementDto {
  @IsInt()
  @Min(1)
  @Max(CASH_CENTS_MAX)
  amountCents!: number;

  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CASH_REASON_MAX_LENGTH)
  reason!: string;
}

export class CloseSessionDto {
  @IsCashOptional()
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CASH_NOTES_MAX_LENGTH)
  notes?: string;
}
