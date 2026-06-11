import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Min,
} from 'class-validator';

export class AttachReceiptRequestDto {
  @IsUrl()
  mediaUrl!: string;

  @IsInt()
  @Min(1)
  declaredAmountCents!: number;

  @IsISO8601()
  @IsOptional()
  declaredDate?: string | null;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  declaredReference?: string | null;
}

export interface AttachReceiptResponse {
  receiptId: string;
  status: 'PENDING';
}
