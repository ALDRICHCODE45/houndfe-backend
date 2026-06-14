import { IsNotEmpty, IsString } from 'class-validator';

export class RejectReceiptDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}
