import {
  quoteCheapest,
  selectCheapestOption,
  ShippingQuoteUnavailableError,
} from './carrier-quote.engine';
import type {
  CarrierQuoteRequest,
  CarrierRateOption,
  ShippingCarrier,
} from './shipping-carrier.port';

const NOW = new Date('2026-11-05T12:00:00.000Z');

const request: CarrierQuoteRequest = {
  tenantId: 't-1',
  origin: {
    postalCode: '06000',
    state: 'CDMX',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Centro',
    addressLine1: 'Av. Juárez 123',
    addressLine2: null,
    contactPhone: '5512345678',
  },
  destination: {
    postalCode: '64000',
    state: 'Nuevo León',
    municipality: 'Monterrey',
    neighborhood: 'Centro',
  },
  parcel: { weightG: 870, lengthCm: 20, widthCm: 15.5, heightCm: 10 },
};

const option = (overrides: Partial<CarrierRateOption>): CarrierRateOption => ({
  carrier: 'A',
  service: 'standard',
  totalCents: 10000,
  etaDays: 3,
  rateId: null,
  validUntil: null,
  ...overrides,
});

const carrier = (
  name: string,
  answer: (signal: AbortSignal) => Promise<CarrierRateOption[]>,
): ShippingCarrier => ({ name, quote: (_req, signal) => answer(signal) });

describe('selectCheapestOption (S6 "Siempre se usa la MÁS BARATA")', () => {
  it('keeps the cheapest total', () => {
    const best = selectCheapestOption(
      [
        {
          carrierName: 'a',
          option: option({ carrier: 'A', totalCents: 15000 }),
        },
        {
          carrierName: 'b',
          option: option({ carrier: 'B', totalCents: 9000 }),
        },
      ],
      NOW,
    );
    expect(best?.option.carrier).toBe('B');
  });

  it('breaks a price tie by shorter ETA, an unknown ETA losing', () => {
    const best = selectCheapestOption(
      [
        { carrierName: 'a', option: option({ carrier: 'A', etaDays: null }) },
        { carrierName: 'b', option: option({ carrier: 'B', etaDays: 4 }) },
        { carrierName: 'c', option: option({ carrier: 'C', etaDays: 2 }) },
      ],
      NOW,
    );
    expect(best?.option.carrier).toBe('C');
  });

  it('breaks a full tie by carrier name, then service, deterministically', () => {
    const entries = [
      { carrierName: 'z', option: option({ carrier: 'Zeta', service: 'b' }) },
      { carrierName: 'a', option: option({ carrier: 'Alfa', service: 'b' }) },
      { carrierName: 'a', option: option({ carrier: 'Alfa', service: 'a' }) },
    ];
    expect(selectCheapestOption(entries, NOW)?.option).toMatchObject({
      carrier: 'Alfa',
      service: 'a',
    });
    expect(
      selectCheapestOption([...entries].reverse(), NOW)?.option,
    ).toMatchObject({ carrier: 'Alfa', service: 'a' });
  });

  it('ignores invalid totals and rates that are no longer valid', () => {
    const best = selectCheapestOption(
      [
        { carrierName: 'a', option: option({ carrier: 'A', totalCents: -1 }) },
        {
          carrierName: 'a',
          option: option({ carrier: 'B', totalCents: 10.5 }),
        },
        {
          carrierName: 'a',
          option: option({ carrier: 'C', totalCents: 1, validUntil: NOW }),
        },
        {
          carrierName: 'a',
          option: option({ carrier: 'D', totalCents: 1, etaDays: -2 }),
        },
        {
          carrierName: 'a',
          option: option({ carrier: 'E', totalCents: 5000 }),
        },
      ],
      NOW,
    );
    expect(best?.option.carrier).toBe('E');
  });

  it('returns null when nothing is usable', () => {
    expect(selectCheapestOption([], NOW)).toBeNull();
  });
});

describe('quoteCheapest (carrier fan-out)', () => {
  it('asks every configured carrier in parallel and keeps the cheapest', async () => {
    const started: string[] = [];
    const slow = carrier('slow', async () => {
      started.push('slow');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [option({ carrier: 'Slow', totalCents: 8000 })];
    });
    const fast = carrier('fast', () => {
      started.push('fast');
      return Promise.resolve([option({ carrier: 'Fast', totalCents: 9000 })]);
    });
    const best = await quoteCheapest([slow, fast], request, {
      timeoutMs: 1000,
      now: () => NOW,
    });
    expect(started).toEqual(['slow', 'fast']);
    expect(best.option.carrier).toBe('Slow');
    expect(best.carrierName).toBe('slow');
  });

  it('uses the other carrier when one fails', async () => {
    const best = await quoteCheapest(
      [
        carrier('broken', () => Promise.reject(new Error('boom'))),
        carrier('ok', () =>
          Promise.resolve([option({ carrier: 'Ok', totalCents: 20000 })]),
        ),
      ],
      request,
      { timeoutMs: 1000, now: () => NOW },
    );
    expect(best.option.carrier).toBe('Ok');
  });

  it('aborts and ignores a carrier past the timeout', async () => {
    let aborted = false;
    const hanging = carrier(
      'hanging',
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve([option({ carrier: 'Late', totalCents: 1 })]);
          });
        }),
    );
    const best = await quoteCheapest(
      [
        hanging,
        carrier('ok', () =>
          Promise.resolve([option({ carrier: 'Ok', totalCents: 20000 })]),
        ),
      ],
      request,
      { timeoutMs: 10, now: () => NOW },
    );
    expect(best.option.carrier).toBe('Ok');
    expect(aborted).toBe(true);
  });

  it('fails with SHIPPING_QUOTE_UNAVAILABLE when every carrier fails', async () => {
    const promise = quoteCheapest(
      [
        carrier('a', () => Promise.reject(new Error('down'))),
        carrier('b', () => Promise.resolve([])),
      ],
      request,
      { timeoutMs: 1000, now: () => NOW },
    );
    await expect(promise).rejects.toBeInstanceOf(ShippingQuoteUnavailableError);
    await expect(promise).rejects.toMatchObject({
      code: 'SHIPPING_QUOTE_UNAVAILABLE',
      details: { carriersAsked: 2 },
    });
  });

  it('fails with SHIPPING_QUOTE_UNAVAILABLE when no carrier is configured', async () => {
    await expect(
      quoteCheapest([], request, { timeoutMs: 1000, now: () => NOW }),
    ).rejects.toMatchObject({
      code: 'SHIPPING_QUOTE_UNAVAILABLE',
      details: { carriersAsked: 0 },
    });
  });

  it('never leaks a carrier error message (it may echo addresses)', async () => {
    await expect(
      quoteCheapest(
        [carrier('a', () => Promise.reject(new Error('Av. Juárez 123')))],
        request,
        { timeoutMs: 1000, now: () => NOW },
      ),
    ).rejects.toThrow(/^No carrier returned a usable rate$/);
  });
});
