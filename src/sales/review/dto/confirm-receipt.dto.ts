import { IsInt, Min } from 'class-validator';

export class ConfirmReceiptDto {
  @IsInt()
  @Min(1)
  amountCents: number;
}
