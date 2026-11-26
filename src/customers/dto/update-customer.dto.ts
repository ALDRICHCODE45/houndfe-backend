import { PartialType, OmitType } from '@nestjs/mapped-types';
import { IsBoolean, ValidateIf } from 'class-validator';
import { CreateCustomerDto } from './create-customer.dto';

export class UpdateCustomerDto extends PartialType(
  OmitType(CreateCustomerDto, ['addresses'] as const),
) {
  /**
   * «Cliente de confianza» (customers-listing T4, contract §6.1). Only a JSON
   * boolean; absent = unchanged. `@ValidateIf` instead of `@IsOptional` so
   * `null` is rejected too (`@IsOptional` would let it through). Update-only:
   * `POST /customers` keeps creating with the default `false`.
   */
  @ValidateIf((_dto: UpdateCustomerDto, value: unknown) => value !== undefined)
  @IsBoolean()
  isTrusted?: boolean;
}
