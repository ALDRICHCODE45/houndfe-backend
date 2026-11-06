/**
 * shipping-zones / T3 (S8) — PORT: persisted shipping quotes.
 *
 * Every call takes the tenant explicitly and the adapter repeats it in the
 * WHERE clause, so a quote of another sucursal is indistinguishable from a
 * missing one. Quotes are written once and never updated.
 */
import type { StandardBox } from '../../packaging/domain/order-package';
import type {
  QuoteDestination,
  QuoteLine,
  StoredQuoteBinding,
} from './shipping-quote-binding';

export type QuoteZoneType = 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY';

export interface QuoteZoneSnapshot {
  zoneId: string;
  zipCode: string;
  type: QuoteZoneType;
  surchargeCents: number | null;
  etaDays: number | null;
}

export interface PricedQuoteLine extends QuoteLine {
  /** Repriced line total after discounts (the credit input). */
  finalPriceCents: number;
}

export interface QuoteDestinationSnapshot extends QuoteDestination {
  source: 'ADDRESS' | 'INPUT';
  shippingAddressId: string | null;
}

export interface QuoteCarrierOption {
  carrier: string;
  service: string;
  etaDays: number | null;
  rateId: string | null;
  validUntil: Date | null;
}

export interface QuoteBoxSnapshot {
  box: StandardBox;
  contentWeightG: number;
  totalWeightG: number;
}

export interface NewShippingQuote {
  tenantId: string;
  tokenHash: string;
  customerId: string | null;
  phoneCountryCode: string;
  phone: string;
  lines: PricedQuoteLine[];
  destination: QuoteDestinationSnapshot;
  zone: QuoteZoneSnapshot;
  option: QuoteCarrierOption | null;
  box: QuoteBoxSnapshot | null;
  etaDays: number | null;
  etaReason: 'STOCK_PENDING' | null;
  costCents: number;
  creditCents: number;
  customerChargeCents: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface StoredShippingQuote extends StoredQuoteBinding {
  customerId: string | null;
  zone: QuoteZoneSnapshot;
  option: QuoteCarrierOption | null;
  box: QuoteBoxSnapshot | null;
  etaDays: number | null;
  etaReason: 'STOCK_PENDING' | null;
  createdAt: Date;
}

export interface IShippingQuoteRepository {
  /** Returns the stored row id. */
  create(quote: NewShippingQuote): Promise<string>;
  findByTokenHash(
    tenantId: string,
    tokenHash: string,
  ): Promise<StoredShippingQuote | null>;
}

export const SHIPPING_QUOTE_REPOSITORY = Symbol('SHIPPING_QUOTE_REPOSITORY');
