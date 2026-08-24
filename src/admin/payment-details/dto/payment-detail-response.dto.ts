/**
 * DTO: PaymentDetailResponseDto — Q1 / WU1.
 *
 * Wire projection for the admin CRUD endpoints. Includes `tenantId` (admins
 * need to disambiguate rows in super-admin mode) and full timestamps.
 *
 * Mirrors the entity's `toResponse()` shape exactly so the controller can
 * return the entity response directly without a separate mapper.
 */
export interface PaymentDetailResponseDto {
  id: string;
  tenantId: string;
  bankName: string;
  beneficiary: string;
  clabe: string;
  accountNumber: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
