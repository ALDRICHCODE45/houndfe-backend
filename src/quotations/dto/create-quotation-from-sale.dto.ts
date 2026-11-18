import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * quotation-sale-conversion / T1 — body of
 * `POST /quotations/from-sale/:saleId`. Optional: POS sales carry no
 * customer-facing notes, so the cashier may type them here (same 280-char
 * limit as `PATCH /quotations/drafts/:id/notes`).
 */
export class CreateQuotationFromSaleDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  customerNotes?: string | null;
}
