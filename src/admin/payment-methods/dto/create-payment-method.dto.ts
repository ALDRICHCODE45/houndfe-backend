/**
 * DTO: CreatePaymentMethodDto — custom-payment-methods / WU1.
 *
 * Validation-only class. The controller pipes `body` through this DTO
 * with the global `ValidationPipe({ whitelist, forbidNonWhitelisted,
 * transform })` so every field MUST pass `class-validator` before
 * reaching the service. The domain entity's sanitizers are the second
 * line of defense (defense in depth).
 *
 * Error-code mapping:
 *   - `name`     → `INVALID_NAME`     (empty / whitespace / non-string)
 *                  `NAME_TOO_LONG`    (>60 chars after trim)
 *   - `category` → `INVALID_CATEGORY` (not in the 4-value whitelist)
 *   - `subtitle` → `INVALID_SUBTITLE` (non-string when supplied)
 *                  `SUBTITLE_TOO_LONG` (>120 chars)
 */
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export const PAYMENT_METHOD_CATEGORY_VALUES = [
  'cash',
  'card_credit',
  'card_debit',
  'transfer',
] as const;

export class CreatePaymentMethodDto {
  @IsString({ message: 'INVALID_NAME' })
  @IsNotEmpty({ message: 'INVALID_NAME' })
  @MaxLength(60, { message: 'NAME_TOO_LONG' })
  @Matches(/\S/, { message: 'INVALID_NAME' })
  name!: string;

  @IsIn(PAYMENT_METHOD_CATEGORY_VALUES, {
    message: 'INVALID_CATEGORY',
  })
  category!: 'cash' | 'card_credit' | 'card_debit' | 'transfer';

  @IsOptional()
  @IsString({ message: 'INVALID_SUBTITLE' })
  @MaxLength(120, { message: 'SUBTITLE_TOO_LONG' })
  subtitle?: string;
}