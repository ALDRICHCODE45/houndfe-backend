import { quoteCheapest } from '../../domain/carrier-quote.engine';
import type { CarrierQuoteRequest } from '../../domain/shipping-carrier.port';
import { FakeShippingCarrier } from '../fake-shipping-carrier';
import type { SkydropxClock, SkydropxRequester } from './skydropx-http.client';
import { SkydropxError } from './skydropx-http.client';
import { SkydropxShippingCarrier } from './skydropx-shipping-carrier';

const T0 = Date.parse('2026-11-05T12:00:00.000Z');

class FakeClock implements SkydropxClock {
  t = T0;
  sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  }
}

interface Sent {
  method: 'GET' | 'POST';
  path: string;
  body: unknown;
  timeoutMs: number | undefined;
}

function requester(
  answer: (sent: Sent, index: number) => unknown,
): SkydropxRequester & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    request: (method, path, body, signal, timeoutMs) => {
      if (signal?.aborted) return Promise.reject(new Error('aborted'));
      const entry = { method, path, body, timeoutMs };
      sent.push(entry);
      try {
        const result = answer(entry, sent.length - 1);
        return Promise.resolve({ status: 200, body: result });
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },
  };
}

const request: CarrierQuoteRequest = {
  tenantId: 't-1',
  origin: {
    postalCode: '06000',
    state: 'Ciudad de México',
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
  parcel: { weightG: 1870, lengthCm: 30, widthCm: 20.2, heightCm: 10 },
};

const pricedRate = (id: string, total: string, days = 3) => ({
  id,
  success: true,
  provider_name: 'estafeta',
  provider_display_name: 'Estafeta',
  provider_service_name: 'Terrestre',
  status: 'price_found_internal',
  currency_code: 'MXN',
  total,
  days,
});

const settings = { pollIntervalMs: 1000, deadlineMs: 10_000 };

describe('SkydropxShippingCarrier', () => {
  it('creates a quotation from origin, destination and parcel, then polls until completed', async () => {
    const clock = new FakeClock();
    const http = requester((sent, index) => {
      if (sent.method === 'POST')
        return { id: 'q-1', is_completed: false, rates: [] };
      return index < 3
        ? {
            id: 'q-1',
            is_completed: false,
            rates: [pricedRate('early', '1.00')],
          }
        : {
            id: 'q-1',
            is_completed: true,
            rates: [
              pricedRate('r-1', '189.99', 2),
              { id: 'bad', success: false },
            ],
          };
    });
    const carrier = new SkydropxShippingCarrier(http, settings, clock);

    const options = await carrier.quote(request, new AbortController().signal);

    expect(carrier.name).toBe('skydropx');
    expect(http.sent[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/quotations',
      body: {
        quotation: {
          address_from: {
            country_code: 'MX',
            postal_code: '06000',
            area_level1: 'Ciudad de México',
            area_level2: 'Cuauhtémoc',
            area_level3: 'Centro',
          },
          address_to: {
            country_code: 'MX',
            postal_code: '64000',
            area_level1: 'Nuevo León',
            area_level2: 'Monterrey',
            area_level3: 'Centro',
          },
          parcels: [{ length: 30, width: 21, height: 10, weight: 1.87 }],
        },
      },
    });
    expect(http.sent.slice(1).map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /api/v1/quotations/q-1',
      'GET /api/v1/quotations/q-1',
      'GET /api/v1/quotations/q-1',
    ]);
    expect(clock.sleeps).toEqual([1000, 1000, 1000]);
    // Only rates of the COMPLETED quotation, valid 24 h from the request.
    expect(options).toEqual([
      {
        carrier: 'Skydropx/Estafeta',
        service: 'Terrestre',
        totalCents: 18999,
        etaDays: 2,
        rateId: 'r-1',
        validUntil: new Date(T0 + 24 * 60 * 60 * 1000),
      },
    ]);
  });

  it('does not poll when the creation answer is already completed', async () => {
    const http = requester(() => ({
      id: 'q-1',
      is_completed: true,
      rates: [pricedRate('r-1', '99.00')],
    }));
    const options = await new SkydropxShippingCarrier(
      http,
      settings,
      new FakeClock(),
    ).quote(request, new AbortController().signal);
    expect(http.sent).toHaveLength(1);
    expect(options.map((o) => o.totalCents)).toEqual([9900]);
  });

  it('fails when the quotation is not completed before the deadline', async () => {
    const clock = new FakeClock();
    const http = requester((sent) =>
      sent.method === 'POST'
        ? { id: 'q-1', is_completed: false }
        : { id: 'q-1', is_completed: false, rates: [] },
    );
    const carrier = new SkydropxShippingCarrier(
      http,
      { pollIntervalMs: 1000, deadlineMs: 3500 },
      clock,
    );

    await expect(
      carrier.quote(request, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'SkydropxError', status: null });
    // Polls at +1 s, +2 s, +3 s; a 4th wait would end past the deadline.
    expect(http.sent.filter((s) => s.method === 'GET')).toHaveLength(3);
    expect(clock.now() - T0).toBeLessThanOrEqual(3500);
  });

  it('bounds every HTTP call by the time left before the deadline', async () => {
    const clock = new FakeClock();
    const http = requester((sent) =>
      sent.method === 'POST'
        ? { id: 'q-1', is_completed: false }
        : { id: 'q-1', is_completed: true, rates: [] },
    );
    await new SkydropxShippingCarrier(
      http,
      { pollIntervalMs: 1000, deadlineMs: 4000 },
      clock,
    ).quote(request, new AbortController().signal);
    expect(http.sent.map((s) => s.timeoutMs)).toEqual([4000, 3000]);
  });

  it('fails when the creation answer has no quotation id', async () => {
    const http = requester(() => ({ is_completed: false }));
    await expect(
      new SkydropxShippingCarrier(http, settings, new FakeClock()).quote(
        request,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SkydropxError);
  });

  it('refuses to call Skydropx when a required address label is missing', async () => {
    const http = requester(() => ({}));
    await expect(
      new SkydropxShippingCarrier(http, settings, new FakeClock()).quote(
        {
          ...request,
          destination: { ...request.destination, neighborhood: '  ' },
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SkydropxError);
    await expect(
      new SkydropxShippingCarrier(http, settings, new FakeClock()).quote(
        { ...request, origin: { ...request.origin, state: null } },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SkydropxError);
    expect(http.sent).toHaveLength(0);
  });

  it('stops polling when the engine aborts', async () => {
    const controller = new AbortController();
    const http = requester((sent, index) => {
      if (index === 2) controller.abort();
      return sent.method === 'POST'
        ? { id: 'q-1', is_completed: false }
        : { id: 'q-1', is_completed: false };
    });
    await expect(
      new SkydropxShippingCarrier(http, settings, new FakeClock()).quote(
        request,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(http.sent).toHaveLength(3);
  });

  it('a Skydropx failure makes the engine fall back to the other carrier', async () => {
    const http = requester(() => {
      throw new SkydropxError('Skydropx POST /api/v1/quotations failed', 503);
    });
    const skydropx = new SkydropxShippingCarrier(
      http,
      settings,
      new FakeClock(),
    );
    const other = new FakeShippingCarrier('other', () =>
      Promise.resolve([
        {
          carrier: 'Other',
          service: 'standard',
          totalCents: 30000,
          etaDays: 4,
          rateId: null,
          validUntil: null,
        },
      ]),
    );

    const best = await quoteCheapest([skydropx, other], request, {
      timeoutMs: 1000,
      now: () => new Date(T0),
    });
    expect(best.carrierName).toBe('other');
  });

  it('the engine keeps the cheapest Skydropx rate', async () => {
    const http = requester(() => ({
      id: 'q-1',
      is_completed: true,
      rates: [
        pricedRate('slow', '150.00', 5),
        pricedRate('cheap', '120.50', 4),
        pricedRate('fast', '150.00', 1),
      ],
    }));
    const skydropx = new SkydropxShippingCarrier(
      http,
      settings,
      new FakeClock(),
    );
    const best = await quoteCheapest([skydropx], request, {
      timeoutMs: 1000,
      now: () => new Date(T0),
    });
    expect(best.option).toMatchObject({ rateId: 'cheap', totalCents: 12050 });
  });
});
