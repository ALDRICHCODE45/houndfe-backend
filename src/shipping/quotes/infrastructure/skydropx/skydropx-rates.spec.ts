import {
  mapSkydropxRates,
  parseMxnToCents,
  toSkydropxParcel,
} from './skydropx-rates';

const VALID_UNTIL = new Date('2026-11-06T12:00:00.000Z');

const rate = (overrides: Record<string, unknown> = {}) => ({
  id: 'rate-1',
  success: true,
  provider_name: 'estafeta',
  provider_display_name: 'Estafeta',
  provider_service_name: 'Terrestre',
  provider_service_code: 'ground',
  status: 'price_found_internal',
  currency_code: 'MXN',
  amount: '129.31',
  total: '150.00',
  days: 3,
  error_messages: null,
  ...overrides,
});

describe('parseMxnToCents', () => {
  it.each([
    ['150.0', 15000],
    ['150', 15000],
    ['0.1', 10],
    ['189.99', 18999],
    ['189.994', 18999],
    ['189.995', 19000],
    ['  99.5 ', 9950],
    [150.1, 15010],
    [0.29, 29],
    [1234567.89, 123456789],
  ])('converts %p to %p cents without float drift', (input, cents) => {
    expect(parseMxnToCents(input)).toBe(cents);
  });

  it.each([
    [''],
    ['abc'],
    ['-5.00'],
    ['1,234.50'],
    ['1e3'],
    [null],
    [undefined],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [-1],
    [{}],
    ['99999999999999999999'],
  ])('rejects %p', (input) => {
    expect(parseMxnToCents(input)).toBeNull();
  });
});

describe('mapSkydropxRates', () => {
  it('maps a priced rate to a carrier option, taxes-included total in cents', () => {
    expect(mapSkydropxRates([rate()], VALID_UNTIL)).toEqual([
      {
        carrier: 'Skydropx/Estafeta',
        service: 'Terrestre',
        totalCents: 15000,
        etaDays: 3,
        rateId: 'rate-1',
        validUntil: VALID_UNTIL,
      },
    ]);
  });

  it('falls back to provider_name, service code and null ETA', () => {
    const [option] = mapSkydropxRates(
      [
        rate({
          provider_display_name: null,
          provider_service_name: '',
          days: null,
          status: 'approved',
          total: 210.5,
        }),
      ],
      VALID_UNTIL,
    );
    expect(option).toMatchObject({
      carrier: 'Skydropx/estafeta',
      service: 'ground',
      totalCents: 21050,
      etaDays: null,
    });
  });

  it('skips failed, unpriced, erroring, foreign-currency and malformed rates', () => {
    const options = mapSkydropxRates(
      [
        rate({ id: 'ok', status: 'price_found_external' }),
        rate({ id: 'not-success', success: false }),
        rate({ id: 'pending', status: 'pending' }),
        rate({ id: 'no-coverage', status: 'no_coverage' }),
        rate({ id: 'no-price', status: 'tariff_price_not_found' }),
        rate({ id: 'not-applicable', status: 'not_applicable' }),
        rate({
          id: 'errors',
          error_messages: [{ error_message: 'max_weight debe ser ≤ 70' }],
        }),
        rate({ id: 'usd', currency_code: 'USD' }),
        rate({ id: 'zero', total: '0.00' }),
        rate({ id: 'bad-total', total: 'N/A' }),
        rate({
          id: 'no-provider',
          provider_name: '',
          provider_display_name: '',
        }),
        'garbage',
        null,
      ],
      VALID_UNTIL,
    );
    expect(options.map((o) => o.rateId)).toEqual(['ok']);
  });

  describe('a rate without `status` (chatbot reference validations)', () => {
    const unstatused = (overrides: Record<string, unknown> = {}) => {
      const raw: Record<string, unknown> = rate(overrides);
      delete raw.status;
      return raw;
    };

    it('is kept when success, MXN, names, whole days and a positive canonical total hold', () => {
      expect(
        mapSkydropxRates(
          [unstatused(), rate({ id: 'null-status', status: null })],
          VALID_UNTIL,
        ),
      ).toEqual([
        expect.objectContaining({
          carrier: 'Skydropx/Estafeta',
          service: 'Terrestre',
          totalCents: 15000,
          etaDays: 3,
          rateId: 'rate-1',
        }),
        expect.objectContaining({ rateId: 'null-status' }),
      ]);
    });

    it('is dropped when any reference validation fails', () => {
      const options = mapSkydropxRates(
        [
          unstatused({ id: 'ok' }),
          unstatused({ id: 'not-success', success: 'true' }),
          unstatused({ id: 'no-currency', currency_code: undefined }),
          unstatused({ id: 'usd', currency_code: 'USD' }),
          unstatused({ id: 'lower-mxn', currency_code: 'mxn' }),
          unstatused({ id: 'no-display', provider_display_name: undefined }),
          unstatused({ id: 'blank-display', provider_display_name: '  ' }),
          unstatused({
            id: 'long-display',
            provider_display_name: 'E'.repeat(129),
          }),
          unstatused({ id: 'no-service', provider_service_name: null }),
          unstatused({
            id: 'long-service',
            provider_service_name: 'T'.repeat(129),
          }),
          unstatused({ id: 'no-days', days: null }),
          unstatused({ id: 'fraction-days', days: 2.5 }),
          unstatused({ id: 'negative-days', days: -1 }),
          unstatused({ id: 'zero-total', total: '0' }),
          unstatused({ id: 'three-decimals', total: '150.005' }),
          unstatused({ id: 'leading-zero', total: '0150.00' }),
          unstatused({ id: 'padded', total: ' 150.00' }),
          unstatused({
            id: 'errors',
            error_messages: [{ error_message: 'sin cobertura' }],
          }),
        ],
        VALID_UNTIL,
      );
      expect(options.map((o) => o.rateId)).toEqual(['ok']);
    });

    it('accepts names of exactly 128 characters and a JSON-number total', () => {
      const [option] = mapSkydropxRates(
        [
          unstatused({
            provider_display_name: 'E'.repeat(128),
            provider_service_name: 'T'.repeat(128),
            total: 99.5,
            days: 0,
          }),
        ],
        VALID_UNTIL,
      );
      expect(option).toMatchObject({ totalCents: 9950, etaDays: 0 });
    });
  });

  it('keeps a rate whose ETA is malformed but drops the ETA', () => {
    const [option] = mapSkydropxRates([rate({ days: -1 })], VALID_UNTIL);
    expect(option.etaDays).toBeNull();
    const [fractional] = mapSkydropxRates([rate({ days: 2.5 })], VALID_UNTIL);
    expect(fractional.etaDays).toBeNull();
  });

  it('returns [] when rates is not an array', () => {
    expect(mapSkydropxRates(undefined, VALID_UNTIL)).toEqual([]);
    expect(mapSkydropxRates({}, VALID_UNTIL)).toEqual([]);
  });
});

describe('toSkydropxParcel', () => {
  it('rounds dimensions up to whole cm and weight up to whole grams in kg, minimum 1 kg', () => {
    expect(
      toSkydropxParcel({
        weightG: 870,
        lengthCm: 20,
        widthCm: 15.5,
        heightCm: 0.4,
      }),
    ).toEqual({ length: 20, width: 16, height: 1, weight: 1 });
    expect(
      toSkydropxParcel({
        weightG: 2345.2,
        lengthCm: 30.1,
        widthCm: 20,
        heightCm: 10,
      }),
    ).toEqual({ length: 31, width: 20, height: 10, weight: 2.346 });
  });
});
