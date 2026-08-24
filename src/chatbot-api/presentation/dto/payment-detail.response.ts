/**
 * DTO: PaymentDetailResponse — Q1 / WU1.
 *
 * Wire projection for `GET /chatbot-api/payment-details`. Excludes the
 * admin-only fields (`tenantId`, `bankName` is kept because the bot needs
 * it; `beneficiary` because the customer needs to confirm the payee name).
 *
 * Per spec (R5 — Bot Reads Active Tenant Payment Detail):
 *   `{ id, bankName, beneficiary, clabe, accountNumber, isActive, updatedAt }`
 */
export interface PaymentDetailResponse {
  id: string;
  bankName: string;
  beneficiary: string;
  clabe: string;
  accountNumber: string;
  isActive: boolean;
  updatedAt: string;
}
