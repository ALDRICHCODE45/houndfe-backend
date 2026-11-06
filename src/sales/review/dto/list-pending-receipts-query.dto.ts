import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Query of GET /sales/receipts/pending (tenant-wide review worklist). */
export class ListPendingReceiptsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Opaque `nextCursor` of the previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
