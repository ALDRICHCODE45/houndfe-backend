import { IsOptional, IsString, ValidateIf } from 'class-validator';

export class UpdateSalePaymentReferenceDto {
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null && value !== undefined)
  @IsString()
  reference?: string | null;
}
