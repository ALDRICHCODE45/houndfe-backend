import type { BotSaleResponse } from './bot-sale.response';

export interface CheckoutResponse {
  status: 'created';
  customer: {
    resolution: 'created' | 'existing';
    customerId: string;
    firstName: string;
    lastName: string | null;
  };
  address: {
    resolution: 'created' | 'existing';
    id: string;
    version: string;
  };
  sale: BotSaleResponse;
}

export type CheckoutStatusResponse =
  | { status: 'succeeded'; checkout: CheckoutResponse }
  | { status: 'not_observed'; checkout: null };
