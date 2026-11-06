import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Min,
} from 'class-validator';

/**
 * Legacy JSON body (`mediaUrl`), kept until the chatbot confirms the
 * multipart migration. New uploads send the file as multipart (see
 * docs/transfer-receipts.md).
 */
export class AttachReceiptRequestDto {
  @IsUrl()
  mediaUrl!: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  declaredAmountCents?: number | null;

  @IsISO8601()
  @IsOptional()
  declaredDate?: string | null;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  declaredReference?: string | null;
}
