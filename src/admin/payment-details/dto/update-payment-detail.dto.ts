/**
 * DTO: UpdatePaymentDetailDto — Q1 / WU1.
 *
 * Partial — every field is optional. The service calls `entity.update(input)`
 * which only mutates the supplied fields. The same `class-validator` rules
 * apply when a field IS supplied (so a 17-digit CLABE on PATCH still 400s).
 */
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  Matches,
  MinLength,
} from 'class-validator';

export class UpdatePaymentDetailDto {
  @IsString()
  @IsOptional()
  @Matches(/^\d{18}$/, {
    message: 'clabe must be exactly 18 digits',
  })
  clabe?: string;

  @IsString()
  @IsOptional()
  @MinLength(10)
  @Matches(/^\d+$/, {
    message: 'accountNumber must contain only digits',
  })
  accountNumber?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @Matches(/\S/, {
    message: 'bankName must contain non-whitespace characters',
  })
  bankName?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @Matches(/\S/, {
    message: 'beneficiary must contain non-whitespace characters',
  })
  beneficiary?: string;
}
