import { IsInt, Min } from 'class-validator';

/** POST /sales/:id/hold/expire — pay-in-store-pickup / T6 (S11). */
export class ExpireSaleHoldDto {
  /** `hold.version` the caller read; a stale value returns 409. */
  @IsInt()
  @Min(0)
  expectedVersion: number;
}
