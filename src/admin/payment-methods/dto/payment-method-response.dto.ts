/**
 * DTO: PaymentMethodResponseDto — custom-payment-methods / WU1.
 *
 * Wire projection for the admin CRUD endpoints. Includes `tenantId`
 * (admins need to disambiguate rows in super-admin mode) and full
 * timestamps. Mirrors the entity's `toResponse()` shape exactly so the
 * controller can return the entity response directly without a separate
 * mapper.
 *
 * `metadataJson` is intentionally OMITTED — the admin response stays
 * narrow (the field is admin-only; the POS projection D4 does not
 * include it either).
 */
export interface PaymentMethodResponseDto {
  id: string;
  tenantId: string;
  name: string;
  category: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
  subtitle: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}