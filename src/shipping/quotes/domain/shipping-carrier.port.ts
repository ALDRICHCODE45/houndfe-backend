/**
 * shipping-zones / T3 (S6) — PORT: one parcel carrier (Skydropx, Envíos
 * Perros, or the explicit fake for dev/tests).
 *
 * `quote` resolves every rate the carrier offers for ONE package. An adapter
 * that needs several round trips (Skydropx: create a quotation, poll until it
 * is complete) does them inside `quote` and must stop when `signal` aborts:
 * the engine aborts it at its timeout and ignores any late answer.
 */

export interface CarrierAddress {
  postalCode: string;
  state: string | null;
  municipality: string | null;
  neighborhood: string | null;
}

export interface CarrierOriginAddress extends CarrierAddress {
  addressLine1: string;
  addressLine2: string | null;
  contactPhone: string;
}

export interface CarrierParcel {
  /** Total weight in grams: content + box. */
  weightG: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface CarrierQuoteRequest {
  /** Owning sucursal, for adapters that keep per-tenant accounts later. */
  tenantId: string;
  origin: CarrierOriginAddress;
  destination: CarrierAddress;
  parcel: CarrierParcel;
}

export interface CarrierRateOption {
  /** Carrier name as shown to the customer (e.g. "Skydropx/Estafeta"). */
  carrier: string;
  service: string;
  /** Total the carrier charges, taxes included, in MXN cents. */
  totalCents: number;
  /** Delivery days the carrier reports; null when it gives none. */
  etaDays: number | null;
  /** Carrier rate id to buy the label later; null when it has none. */
  rateId: string | null;
  /** End of the rate validity (Skydropx: 24 h); null when unbounded. */
  validUntil: Date | null;
}

export interface ShippingCarrier {
  /** Stable registry name, used in logs and as the last tie-break. */
  readonly name: string;
  quote(
    request: CarrierQuoteRequest,
    signal: AbortSignal,
  ): Promise<CarrierRateOption[]>;
}

/** Every CONFIGURED carrier; empty when none is configured. */
export const SHIPPING_CARRIERS = Symbol('SHIPPING_CARRIERS');
