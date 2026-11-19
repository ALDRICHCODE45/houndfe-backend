import { IsIn } from 'class-validator';

/** PATCH /chatbot-api/sales/:saleId/payment-intent — pay-in-store-pickup / T1. */
export class PaymentIntentRequestDto {
  /** Only `IN_STORE` (pay at the counter on pickup) exists today. */
  @IsIn(['IN_STORE'])
  method: 'IN_STORE';
}
