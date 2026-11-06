/**
 * shipping-zones / T3 (S6) — "Siempre se usa la MÁS BARATA".
 *
 * Asks every configured carrier in parallel, each bounded by one timeout, and
 * keeps the cheapest usable rate among those that answered. Ties: shorter ETA
 * (an unknown ETA loses), then carrier name, then service, so the choice never
 * depends on answer order. A carrier that fails, times out or returns nothing
 * usable is skipped; none left → SHIPPING_QUOTE_UNAVAILABLE.
 */
import { BusinessRuleViolationError } from '../../../shared/domain/domain-error';
import type {
  CarrierQuoteRequest,
  CarrierRateOption,
  ShippingCarrier,
} from './shipping-carrier.port';

export interface CarrierRateEntry {
  /** Registry name of the carrier that answered. */
  carrierName: string;
  option: CarrierRateOption;
}

export class ShippingQuoteUnavailableError extends BusinessRuleViolationError {
  constructor(carriersAsked: number) {
    // Never the carrier's own message: it can echo addresses or phones, and
    // the bot audit log stores error messages verbatim.
    super('No carrier returned a usable rate', 'SHIPPING_QUOTE_UNAVAILABLE', {
      carriersAsked,
    });
  }
}

function isUsable(option: CarrierRateOption, now: Date): boolean {
  return (
    Number.isSafeInteger(option.totalCents) &&
    option.totalCents >= 0 &&
    (option.etaDays === null ||
      (Number.isInteger(option.etaDays) && option.etaDays >= 0)) &&
    (option.validUntil === null || option.validUntil.getTime() > now.getTime())
  );
}

const etaRank = (etaDays: number | null): number =>
  etaDays ?? Number.POSITIVE_INFINITY;

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export function selectCheapestOption(
  entries: CarrierRateEntry[],
  now: Date,
): CarrierRateEntry | null {
  const usable = entries.filter((entry) => isUsable(entry.option, now));
  usable.sort(
    (a, b) =>
      a.option.totalCents - b.option.totalCents ||
      etaRank(a.option.etaDays) - etaRank(b.option.etaDays) ||
      compareText(a.option.carrier, b.option.carrier) ||
      compareText(a.option.service, b.option.service) ||
      compareText(a.carrierName, b.carrierName),
  );
  return usable[0] ?? null;
}

export interface QuoteCheapestOptions {
  timeoutMs: number;
  now: () => Date;
}

async function askCarrier(
  carrier: ShippingCarrier,
  request: CarrierQuoteRequest,
  timeoutMs: number,
): Promise<CarrierRateEntry[]> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Settle the race first: an adapter answering on abort must lose it.
      reject(new Error(`carrier ${carrier.name} timed out`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const options = await Promise.race([
      carrier.quote(request, controller.signal),
      timeout,
    ]);
    return options.map((option) => ({ carrierName: carrier.name, option }));
  } finally {
    clearTimeout(timer);
  }
}

export async function quoteCheapest(
  carriers: readonly ShippingCarrier[],
  request: CarrierQuoteRequest,
  options: QuoteCheapestOptions,
): Promise<CarrierRateEntry> {
  const settled = await Promise.allSettled(
    carriers.map((carrier) => askCarrier(carrier, request, options.timeoutMs)),
  );
  const entries = settled.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
  const best = selectCheapestOption(entries, options.now());
  if (!best) throw new ShippingQuoteUnavailableError(carriers.length);
  return best;
}
