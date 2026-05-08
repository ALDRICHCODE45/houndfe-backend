import { IsIn, IsInt, Min } from 'class-validator';

export class ChargeSaleDto {
  @IsIn(['cash', 'card_credit', 'card_debit', 'transfer', 'credit'])
  method: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';

  @IsInt()
  @Min(1)
  amountCents: number;
}
