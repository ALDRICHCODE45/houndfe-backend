import { IsInt, IsISO8601, Min } from 'class-validator';

/** PATCH /sales/:id/hold — pay-in-store-pickup / T1 (S5). */
export class UpdateSaleHoldDto {
  /** New deadline, ISO 8601 with a time and offset; must be in the future. */
  @IsISO8601({ strict: true, strictSeparator: true })
  expiresAt: string;

  /** `hold.version` the caller read; a stale value returns 409. */
  @IsInt()
  @Min(0)
  expectedVersion: number;
}
