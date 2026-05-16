import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class ChargePaymentEntryDto {
  @IsIn(['cash', 'card_credit', 'card_debit', 'transfer', 'credit'])
  method: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';

  @IsInt()
  @Min(0)
  amountCents: number;

  @IsOptional()
  @IsString()
  reference?: string;
}

export class ChargeSaleDto {
  @IsOptional()
  @IsIn(['cash', 'card_credit', 'card_debit', 'transfer', 'credit'])
  method?: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';

  @IsOptional()
  @IsInt()
  @Min(0)
  amountCents?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ChargePaymentEntryDto)
  payments?: ChargePaymentEntryDto[];

  @IsOptional()
  @IsISO8601()
  dueDate?: string;
}
