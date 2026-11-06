/**
 * shipping-zones / T6 (S6) — Skydropx behind the `ShippingCarrier` port.
 *
 * One quote = `POST /api/v1/quotations` with the sucursal origin, the
 * destination and the order package, then `GET /api/v1/quotations/:id`
 * every `pollIntervalMs` until `is_completed`. The whole flow is bounded by
 * `deadlineMs` (kept below the engine timeout, see `skydropx.config.ts`);
 * past it the quote fails and the engine uses the other carriers. Rates are
 * valid 24 h from the quotation request.
 */
import { Logger } from '@nestjs/common';
import type {
  CarrierAddress,
  CarrierQuoteRequest,
  CarrierRateOption,
  ShippingCarrier,
} from '../../domain/shipping-carrier.port';
import {
  type SkydropxClock,
  SkydropxError,
  type SkydropxRequester,
  systemClock,
} from './skydropx-http.client';
import { mapSkydropxRates, toSkydropxParcel } from './skydropx-rates';

export interface SkydropxQuoteSettings {
  pollIntervalMs: number;
  /** Overall bound of one quote: creation + polling. */
  deadlineMs: number;
}

const RATE_VALIDITY_MS = 24 * 60 * 60 * 1000;
const QUOTATIONS_PATH = '/api/v1/quotations';

interface QuotationBody {
  id?: unknown;
  is_completed?: unknown;
  rates?: unknown;
}

function address(which: string, value: CarrierAddress) {
  const labels = [value.state, value.municipality, value.neighborhood].map(
    (part) => part?.trim() ?? '',
  );
  if (!/^\d{5}$/.test(value.postalCode) || labels.some((part) => part === '')) {
    // Skydropx requires postal code, state, municipality and colony.
    throw new SkydropxError(`Skydropx needs a complete ${which} address`, null);
  }
  return {
    country_code: 'MX',
    postal_code: value.postalCode,
    area_level1: labels[0],
    area_level2: labels[1],
    area_level3: labels[2],
  };
}

export class SkydropxShippingCarrier implements ShippingCarrier {
  readonly name = 'skydropx';
  private readonly logger = new Logger('SkydropxShippingCarrier');

  constructor(
    private readonly http: SkydropxRequester,
    private readonly settings: SkydropxQuoteSettings,
    private readonly clock: SkydropxClock = systemClock,
  ) {}

  async quote(
    request: CarrierQuoteRequest,
    signal: AbortSignal,
  ): Promise<CarrierRateOption[]> {
    try {
      return await this.run(request, signal);
    } catch (error) {
      if (!signal.aborted) {
        // SkydropxError messages hold only method, path and status.
        this.logger.warn(
          `Skydropx quote failed: ${
            error instanceof SkydropxError
              ? error.message
              : ((error as Error)?.name ?? 'unknown error')
          }`,
        );
      }
      throw error;
    }
  }

  private async run(
    request: CarrierQuoteRequest,
    signal: AbortSignal,
  ): Promise<CarrierRateOption[]> {
    const body = {
      quotation: {
        address_from: address('origin', request.origin),
        address_to: address('destination', request.destination),
        parcels: [toSkydropxParcel(request.parcel)],
      },
    };
    const startedAt = this.clock.now();
    const deadlineAt = startedAt + this.settings.deadlineMs;
    const validUntil = new Date(startedAt + RATE_VALIDITY_MS);
    const left = () => deadlineAt - this.clock.now();

    const created = await this.http.request(
      'POST',
      QUOTATIONS_PATH,
      body,
      signal,
      left(),
    );
    let quotation = (created.body ?? {}) as QuotationBody;
    const id = quotation.id;
    if (typeof id !== 'string' || id === '') {
      throw new SkydropxError('Skydropx quotation answer has no id', null);
    }
    const path = `${QUOTATIONS_PATH}/${encodeURIComponent(id)}`;

    while (quotation.is_completed !== true) {
      if (signal.aborted) throw signal.reason as Error;
      if (this.clock.now() + this.settings.pollIntervalMs >= deadlineAt) {
        throw new SkydropxError(
          'Skydropx quotation was not completed before the deadline',
          null,
        );
      }
      await this.clock.sleep(this.settings.pollIntervalMs, signal);
      const polled = await this.http.request(
        'GET',
        path,
        undefined,
        signal,
        left(),
      );
      quotation = (polled.body ?? {}) as QuotationBody;
    }
    return mapSkydropxRates(quotation.rates, validUntil);
  }
}
