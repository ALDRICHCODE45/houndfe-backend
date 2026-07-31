import {
  IsIn,
  IsISO8601,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import type { QuotationCancelReason } from '../domain/quotation.entity';

/**
 * Body for `POST /quotations/drafts/:id/cancel`.
 *
 * WU3 — Cancel a quotation in any non-terminal status. The
 * `cancelReason` enum mirrors the domain's `QuotationCancelReason`
 * (`CUSTOMER_REQUEST | PRICE_OBJECTION | EXPIRED | OTHER`).
 *
 * Re-cancelling a CANCELLED quotation is idempotent (the entity's
 * `cancel` returns the same instance) — the wire returns 200 with the
 * existing CANCELLED quotation.
 */
export class CancelQuotationDto {
  @IsIn([
    'CUSTOMER_REQUEST',
    'PRICE_OBJECTION',
    'EXPIRED',
    'OTHER',
  ] as QuotationCancelReason[])
  cancelReason!: QuotationCancelReason;
}
