/**
 * DTO: UpdatePaymentMethodDto — custom-payment-methods / WU1.
 *
 * Partial — every field is optional. The service calls
 * `entity.update(input)` which only mutates the supplied fields. The
 * same `class-validator` rules apply when a field IS supplied (so an
 * over-length `name` on PATCH still 400s).
 *
 * `isActive` is mutable here (D2 reactivation scenario) — PATCHing
 * `{ isActive: true }` flips a deactivated row back to selectable for
 * new charges without recreating the row.
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
import { PAYMENT_METHOD_CATEGORY_VALUES } from './create-payment-method.dto';

export class UpdatePaymentMethodDto {
  @IsOptional()
  @IsString({ message: 'INVALID_NAME' })
  @IsNotEmpty({ message: 'INVALID_NAME' })
  @MaxLength(60, { message: 'NAME_TOO_LONG' })
  @Matches(/\S/, { message: 'INVALID_NAME' })
  name?: string;

  @IsOptional()
  @IsIn(PAYMENT_METHOD_CATEGORY_VALUES, {
    message: 'INVALID_CATEGORY',
  })
  category?: 'cash' | 'card_credit' | 'card_debit' | 'transfer';

  @IsOptional()
  @IsString({ message: 'INVALID_SUBTITLE' })
  @MaxLength(120, { message: 'SUBTITLE_TOO_LONG' })
  subtitle?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}