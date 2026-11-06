/**
 * shipping-zones / T3 (S6) — fake carrier for development and tests.
 *
 * Registered only with SHIPPING_FAKE_CARRIER_ENABLED=true outside production
 * (see `buildShippingCarriers`). Tests pass their own `answer` to script
 * prices, failures and delays. The default answer is deterministic:
 * $99.00 for the first kilogram, $20.00 per extra started kilogram, 3 days,
 * valid 24 h like a Skydropx rate.
 */
import { randomUUID } from 'node:crypto';
import type {
  CarrierQuoteRequest,
  CarrierRateOption,
  ShippingCarrier,
} from '../domain/shipping-carrier.port';

export type FakeCarrierAnswer = (
  request: CarrierQuoteRequest,
  signal: AbortSignal,
) => Promise<CarrierRateOption[]>;

export function defaultFakeRate(
  request: CarrierQuoteRequest,
  now: Date = new Date(),
): CarrierRateOption {
  const extraKg = Math.max(Math.ceil(request.parcel.weightG / 1000) - 1, 0);
  return {
    carrier: 'Fake',
    service: 'standard',
    totalCents: 9900 + 2000 * extraKg,
    etaDays: 3,
    rateId: `fake_${randomUUID()}`,
    validUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  };
}

export class FakeShippingCarrier implements ShippingCarrier {
  constructor(
    readonly name: string = 'fake',
    private readonly answer: FakeCarrierAnswer = (request) =>
      Promise.resolve([defaultFakeRate(request)]),
  ) {}

  quote(
    request: CarrierQuoteRequest,
    signal: AbortSignal,
  ): Promise<CarrierRateOption[]> {
    return this.answer(request, signal);
  }
}
