import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RejectReceiptDto {
  /** Internal reason for staff; never shown to the customer. */
  @IsString()
  @IsNotEmpty()
  reason: string;

  /**
   * Customer-safe text the chatbot may relay (1–300 chars after trimming).
   * Optional for backward compatibility: when omitted the receipt stores
   * DEFAULT_CUSTOMER_REJECTION_REASON. New clients should always send it.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  customerReason?: string;
}
