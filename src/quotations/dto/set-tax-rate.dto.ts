import { IsNumber, Min, Max } from 'class-validator';

export class SetQuotationTaxRateDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  taxRate: number;
}
