import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class AddSalePaymentDto {
  @IsIn(['cash', 'card_credit', 'card_debit', 'transfer'])
  method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';

  @IsInt()
  @Min(1)
  amountCents: number;

  @IsOptional()
  @IsString()
  reference?: string;
}
