import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * sales-history-redesign S4 (contract §5.2) — `GET /customers/:customerId/
 * sales-monthly?months=`: how many local months to return (1–24, default 12),
 * ending with the current one.
 */
export class CustomerSalesMonthlyQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  months: number = 12;
}

export interface CustomerSalesMonthlyEntryDto {
  /** Local month `YYYY-MM` in `timeZone`. */
  month: string;
  /** CONFIRMED sales of the customer with `confirmedAt` in the month. */
  saleCount: number;
  /** Sum of their `totalCents`. */
  totalCents: number;
}

export interface CustomerSalesMonthlyResponseDto {
  customerId: string;
  timeZone: string;
  /** Oldest first; zero months included; the last one is the current month. */
  months: CustomerSalesMonthlyEntryDto[];
}
