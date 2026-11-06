import type { PickupLocation } from '../../../shipping/pickup/application/pickup-location.service';
import type { BotSaleResponse } from './bot-sale.response';

export interface CheckoutResponse {
  status: 'created';
  customer: {
    resolution: 'created' | 'existing';
    customerId: string;
    firstName: string;
    lastName: string | null;
  };
  /** null only for a pickup checkout sent without `deliveryAddress`. */
  address: {
    resolution: 'created' | 'existing' | 'updated';
    id: string;
    version: string;
  } | null;
  sale: BotSaleResponse;
  /** shipping-zones / T7 (S10) — present only for `shipping: { mode: "pickup" }`. */
  pickupLocation?: PickupLocation;
}

export type CheckoutStatusResponse =
  | { status: 'succeeded'; checkout: CheckoutResponse }
  | { status: 'not_observed'; checkout: null };
