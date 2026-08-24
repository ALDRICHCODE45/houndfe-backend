/**
 * DTO: CreatePaymentDetailDto — Q1 / WU1.
 *
 * Validation-only class. The controller pipes `body` through this DTO with
 * the global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`
 * so every field MUST pass `class-validator` before reaching the service.
 *
 * `clabe` and `accountNumber` are validated at the DTO layer so the global
 * pipe can return a 400 BEFORE the service ever sees the payload. The
 * domain entity's sanitizers are the second line of defense (defense in
 * depth).
 */
import { IsString, IsNotEmpty, Matches, MinLength } from 'class-validator';

export class CreatePaymentDetailDto {
  @IsString()
  @Matches(/^\d{18}$/, {
    message: 'clabe must be exactly 18 digits',
  })
  clabe!: string;

  @IsString()
  @MinLength(10)
  @Matches(/^\d+$/, {
    message: 'accountNumber must contain only digits',
  })
  accountNumber!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, {
    message: 'bankName must contain non-whitespace characters',
  })
  bankName!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, {
    message: 'beneficiary must contain non-whitespace characters',
  })
  beneficiary!: string;
}
