/**
 * shipping-zones / T8 (S6, S8) — the persisted quote never has
 * expiresAt <= createdAt (the `shipping_quotes` CHECK would answer 500).
 * The quote is stamped with the instant the carrier rate was chosen, and a
 * rate that is not valid after that instant is never chosen.
 */
import type { ConfigService } from '@nestjs/config';
import type { IDeliveryZoneRepository } from '../../delivery-zones/domain/delivery-zone.repository';
import type { ProductPackagingService } from '../../shipping/packaging/application/product-packaging.service';
import type { ShippingSettingsService } from '../../shipping/packaging/application/shipping-settings.service';
import type {
  CarrierRateOption,
  ShippingCarrier,
} from '../../shipping/quotes/domain/shipping-carrier.port';
import { DEFAULT_SHIPPING_CREDIT_RULE } from '../../shipping/quotes/domain/shipping-credit';
import type {
  NewShippingQuote,
  IShippingQuoteRepository,
} from '../../shipping/quotes/domain/shipping-quote.repository';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ChatbotApiService } from './chatbot-api.service';
import { ShippingQuoteService } from './shipping-quote.service';

/** Time spent after the carrier choice (repricing, credit, ETA, I/O). */
let msAfterChoice = 0;
jest.mock('../../shipping/quotes/domain/carrier-quote.engine', () => {
  const actual = jest.requireActual<
    typeof import('../../shipping/quotes/domain/carrier-quote.engine')
  >('../../shipping/quotes/domain/carrier-quote.engine');
  return {
    ...actual,
    quoteCheapest: async (...args: Parameters<typeof actual.quoteCheapest>) => {
      const best = await actual.quoteCheapest(...args);
      jest.setSystemTime(Date.now() + msAfterChoice);
      return best;
    },
  };
});

const T0 = new Date('2026-11-05T18:00:00.000Z').getTime();

const rate = (
  service: string,
  totalCents: number,
  validUntil: Date | null,
): CarrierRateOption => ({
  carrier: 'Fake',
  service,
  totalCents,
  etaDays: 3,
  rateId: service,
  validUntil,
});

function setup(options: CarrierRateOption[]) {
  const client = {
    product: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'p1', useStock: false, hasVariants: false, quantity: 0 },
        ]),
    },
    variant: { findMany: jest.fn().mockResolvedValue([]) },
    customer: { findMany: jest.fn().mockResolvedValue([{ id: 'c1' }]) },
    lot: { findMany: jest.fn().mockResolvedValue([]) },
    shippingOrigin: {
      findFirst: jest.fn().mockResolvedValue({
        postalCode: '06000',
        state: 'Ciudad de México',
        municipality: 'Cuauhtémoc',
        neighborhood: 'Centro',
        addressLine1: 'Av. Juárez 123',
        addressLine2: null,
        contactPhone: '5512345678',
      }),
    },
  };
  const tenantPrisma = {
    getTenantId: () => 'tenant-1',
    getClient: () => client,
  } as unknown as TenantPrismaService;
  const chatbotApi = {
    evaluateCart: jest.fn().mockResolvedValue({
      items: [
        { productId: 'p1', variantId: null, quantity: 1, finalPriceCents: 1 },
      ],
    }),
  } as unknown as ChatbotApiService;
  const zones = {
    findByZipCode: jest.fn().mockResolvedValue({
      id: 'zone-1',
      zipCode: '64000',
      type: 'CARRIER_ONLY',
      surchargeCents: null,
      etaDays: null,
      isActive: true,
    }),
  } as unknown as IDeliveryZoneRepository;
  const packaging = {
    resolvePackageItems: jest.fn().mockResolvedValue([
      {
        productId: 'p1',
        variantId: null,
        quantity: 1,
        packageWeightG: 500,
        dims: { lengthCm: 10, widthCm: 10, heightCm: 10 },
      },
    ]),
  } as unknown as ProductPackagingService;
  const settings = {
    listActiveBoxes: jest.fn().mockResolvedValue([
      {
        id: 'box-1',
        name: 'Caja',
        innerLengthCm: 30,
        innerWidthCm: 30,
        innerHeightCm: 30,
        weightG: 100,
        maxContentWeightG: 10000,
      },
    ]),
  } as unknown as ShippingSettingsService;
  const carrier: ShippingCarrier = {
    name: 'fake',
    quote: () => Promise.resolve(options),
  };
  const create = jest.fn<Promise<string>, [NewShippingQuote]>(() =>
    Promise.resolve('quote-row-1'),
  );
  const quotes = { create } as unknown as IShippingQuoteRepository;
  const service = new ShippingQuoteService(
    chatbotApi,
    tenantPrisma,
    { get: () => undefined } as unknown as ConfigService,
    zones,
    packaging,
    settings,
    [carrier],
    quotes,
    {
      ttlMinutes: 30,
      carrierTimeoutMs: 1000,
      credit: DEFAULT_SHIPPING_CREDIT_RULE,
      fakeCarrierEnabled: false,
      isProduction: false,
    },
  );
  const quote = () =>
    service.quote({
      phoneCountryCode: '52',
      phone: '5512345678',
      items: [{ productId: 'p1', quantity: 1 }],
      destination: {
        zipCode: '64000',
        state: 'Nuevo León',
        municipality: 'Monterrey',
        neighborhood: 'Centro',
      },
    });
  return { quote, create };
}

describe('ShippingQuoteService — expiry never at or before creation', () => {
  beforeEach(() => {
    msAfterChoice = 0;
    // Only Date is faked: the engine timeout keeps real timers.
    jest.useFakeTimers({
      now: T0,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  });
  afterEach(() => jest.useRealTimers());

  it('stamps the quote at the choice instant, so a rate ending just after it still persists', async () => {
    msAfterChoice = 5;
    const { quote, create } = setup([rate('fast', 9000, new Date(T0 + 1))]);

    const response = await quote();

    const stored = create.mock.calls[0][0];
    expect(stored.createdAt.getTime()).toBe(T0);
    expect(stored.expiresAt.getTime()).toBe(T0 + 1);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(
      stored.createdAt.getTime(),
    );
    expect(response.expiresAt).toBe(new Date(T0 + 1).toISOString());
  });

  it('treats a rate valid only until the choice instant as unusable and falls back to the next cheapest', async () => {
    const { quote, create } = setup([
      rate('ending-now', 9000, new Date(T0)),
      rate('next', 15000, new Date(T0 + 24 * 3_600_000)),
    ]);

    const response = await quote();

    expect(response.option?.service).toBe('next');
    expect(response.costCents).toBe(15000);
    const stored = create.mock.calls[0][0];
    expect(stored.expiresAt.getTime()).toBe(T0 + 30 * 60_000);
    expect(stored.createdAt.getTime()).toBe(T0);
  });

  it('answers SHIPPING_QUOTE_UNAVAILABLE and stores nothing when no rate outlives the choice instant', async () => {
    const { quote, create } = setup([
      rate('ended', 9000, new Date(T0 - 1)),
      rate('ending-now', 12000, new Date(T0)),
    ]);

    await expect(quote()).rejects.toMatchObject({
      code: 'SHIPPING_QUOTE_UNAVAILABLE',
    });
    expect(create).not.toHaveBeenCalled();
  });
});
