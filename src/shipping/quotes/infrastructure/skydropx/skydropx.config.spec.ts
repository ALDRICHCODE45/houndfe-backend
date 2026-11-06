import type { ConfigService } from '@nestjs/config';
import type { ShippingQuotesConfig } from '../../shipping-quotes.config';
import { buildShippingCarriers } from '../shipping-carrier.registry';
import { SkydropxShippingCarrier } from './skydropx-shipping-carrier';
import {
  readSkydropxConfig,
  SKYDROPX_DEFAULT_BASE_URL,
} from './skydropx.config';

const env = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const credentials = {
  SKYDROPX_CLIENT_ID: 'client-id',
  SKYDROPX_CLIENT_SECRET: 'client-secret',
};

const quotesConfig = (
  overrides: Partial<ShippingQuotesConfig> = {},
): ShippingQuotesConfig => ({
  ttlMinutes: 30,
  carrierTimeoutMs: 15000,
  credit: {
    perUnitCreditCents: 12000,
    unitPriceThresholdCents: 50000,
    appliesToSurcharge: true,
  },
  fakeCarrierEnabled: false,
  isProduction: true,
  ...overrides,
});

describe('readSkydropxConfig', () => {
  it('is not configured without both client id and secret', () => {
    expect(readSkydropxConfig(env({}), 15000)).toBeNull();
    expect(
      readSkydropxConfig(env({ SKYDROPX_CLIENT_ID: 'id' }), 15000),
    ).toBeNull();
    expect(
      readSkydropxConfig(
        env({ SKYDROPX_CLIENT_ID: '  ', SKYDROPX_CLIENT_SECRET: 's' }),
        15000,
      ),
    ).toBeNull();
  });

  it('defaults to the production host and timings that fit the engine timeout', () => {
    expect(readSkydropxConfig(env(credentials), 15000)).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      baseUrl: SKYDROPX_DEFAULT_BASE_URL,
      requestTimeoutMs: 5000,
      pollIntervalMs: 1000,
      deadlineMs: 12000,
    });
    expect(SKYDROPX_DEFAULT_BASE_URL).toBe('https://api-pro.skydropx.com');
  });

  it('reads overrides and keeps the deadline below the engine timeout', () => {
    const config = readSkydropxConfig(
      env({
        ...credentials,
        SKYDROPX_BASE_URL: 'https://sb-pro.skydropx.com',
        SKYDROPX_REQUEST_TIMEOUT_MS: '3000',
        SKYDROPX_POLL_INTERVAL_MS: '1500',
        SKYDROPX_QUOTE_DEADLINE_MS: '30000',
      }),
      8000,
    );
    expect(config).toMatchObject({
      baseUrl: 'https://sb-pro.skydropx.com',
      requestTimeoutMs: 3000,
      pollIntervalMs: 1500,
      deadlineMs: 7500,
    });
  });

  it('never polls faster than the 2 req/s limit and ignores malformed numbers', () => {
    expect(
      readSkydropxConfig(
        env({
          ...credentials,
          SKYDROPX_POLL_INTERVAL_MS: '100',
          SKYDROPX_REQUEST_TIMEOUT_MS: 'soon',
        }),
        15000,
      ),
    ).toMatchObject({ pollIntervalMs: 1000, requestTimeoutMs: 5000 });
  });

  it('stays unregistered when the base URL is not https', () => {
    expect(
      readSkydropxConfig(
        env({
          ...credentials,
          SKYDROPX_BASE_URL: 'http://api-pro.skydropx.com',
        }),
        15000,
      ),
    ).toBeNull();
    expect(
      readSkydropxConfig(
        env({ ...credentials, SKYDROPX_BASE_URL: 'not a url' }),
        15000,
      ),
    ).toBeNull();
  });
});

describe('buildShippingCarriers with Skydropx', () => {
  it('registers Skydropx only when configured, in production too', () => {
    const skydropx = readSkydropxConfig(env(credentials), 15000);
    const carriers = buildShippingCarriers(quotesConfig(), skydropx);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toBeInstanceOf(SkydropxShippingCarrier);
    expect(carriers[0].name).toBe('skydropx');

    expect(buildShippingCarriers(quotesConfig(), null)).toEqual([]);
  });

  it('keeps the fake carrier next to Skydropx outside production', () => {
    const skydropx = readSkydropxConfig(env(credentials), 15000);
    const names = buildShippingCarriers(
      quotesConfig({ fakeCarrierEnabled: true, isProduction: false }),
      skydropx,
    ).map((carrier) => carrier.name);
    expect(names).toEqual(['skydropx', 'fake']);
  });
});
