import {
  IsISO8601,
  IsOptional,
  ValidateIf,
} from 'class-validator';

/**
 * Body for `PATCH /quotations/drafts/:id/expiry`.
 *
 * WU3 — Set or clear the optional expiry date on a DRAFT quotation.
 *   - present (ISO8601) → sets `expiresAt` to the parsed date.
 *   - null               → clears the expiry (the quotation never
 *                          auto-transitions to EXPIRED).
 *
 * The lazy EXPIRED transition happens on read via
 * `getEffectiveStatus` — `setExpiry` does NOT mutate the persisted
 * status.
 */
export class SetQuotationExpiryDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsISO8601()
  expiresAt?: string | null;
}
