import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { createHash } from 'node:crypto';
import { CheckoutRequestDto } from '../presentation/dto/checkout.request';
import {
  CheckoutService,
  computeCheckoutRequestHash,
} from './checkout.service';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';

const id = '00000000-0000-4000-8000-000000000001';
const version = '2026-10-14T00:00:00.000Z';
const address = {
  street: 'Street',
  label: 'Home',
  exteriorNumber: '12',
  interiorNumber: '2',
  zipCode: '64000',
  neighborhood: 'Centro',
  municipality: 'Monterrey',
  city: 'Monterrey',
  state: 'Nuevo León',
  visualReferences: 'Blue gate',
  carrierPhone: '5512345678',
};
const input = (deliveryAddress: object) => ({
  phoneCountryCode: '52',
  phone: '5512345678',
  customer: { mode: 'existing', customerId: id },
  deliveryAddress,
  sale: {
    cashierUserId: id,
    items: [
      { productId: id, productName: 'Item', quantity: 1, unitPriceCents: 100 },
    ],
    expectedTotalCents: 100,
  },
});
const hash = (deliveryAddress: object) =>
  computeCheckoutRequestHash(
    plainToInstance(CheckoutRequestDto, input(deliveryAddress)),
  );
const correction = () => ({
  mode: 'existingUpdated',
  addressId: id,
  expectedVersion: version,
  address: { ...address },
});

describe('Checkout confirmation rejection', () => {
  it.each([
    'PRICE_OUT_OF_DATE',
    'BOT_ITEM_VARIANT_REQUIRED',
    'BOT_ITEM_VARIANT_NOT_ALLOWED',
    'BOT_ITEM_VARIANT_MISMATCH',
  ])(
    'rolls back customer/address effects and skips receipt on %s',
    async (code) => {
      const pending: string[] = [];
      const committed: string[] = [];
      const receiptCreate = jest.fn();
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]),
        saleIdempotency: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: receiptCreate,
        },
        tenantMembership: { findFirst: jest.fn().mockResolvedValue({ id }) },
        customer: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockImplementation(() => {
            pending.push('customer');
            return { id, firstName: 'Buyer', lastName: null };
          }),
        },
        customerAddress: {
          create: jest.fn().mockImplementation(() => {
            pending.push('address');
            return { id, updatedAt: new Date(version) };
          }),
        },
      };
      const tenant = {
        getTenantId: () => 'tenant-1',
        getClient: () => tx,
        runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
          try {
            const result = await work();
            committed.push(...pending);
            return result;
          } finally {
            pending.length = 0;
          }
        }),
      };
      const rejection = new BusinessRuleViolationError(code, code);
      const confirmBotSale = jest.fn().mockImplementation(() => {
        expect(pending).toEqual(['customer', 'address']);
        return Promise.reject(rejection);
      });
      const service = new CheckoutService(
        tenant as never,
        { confirmBotSale } as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const request = plainToInstance(CheckoutRequestDto, {
        ...input({ mode: 'newSaved', address }),
        customer: { mode: 'createIfAbsent', firstName: 'Buyer' },
      });
      await expect(service.create(request, 'key')).rejects.toBe(rejection);
      expect(tenant.runInTransaction).toHaveBeenCalledTimes(1);
      expect(confirmBotSale).toHaveBeenCalledTimes(1);
      expect(committed).toEqual([]);
      expect(receiptCreate).not.toHaveBeenCalled();
    },
  );
});

describe('Checkout intent hash', () => {
  it.each([
    {
      mode: 'existing',
      addressId: id,
      expectedVersion: version,
    },
    { mode: 'newSaved', address },
  ])('preserves the exact legacy $mode canonical bytes', (deliveryAddress) => {
    // Frozen pre-correction serialization: field order and null defaults are intentional.
    const canonical = JSON.stringify({
      phoneCountryCode: '52',
      phone: '5512345678',
      customer: { mode: 'existing', customerId: id },
      deliveryAddress,
      sale: {
        cashierUserId: id,
        items: [
          {
            productId: id,
            variantId: null,
            productName: 'Item',
            variantName: null,
            quantity: 1,
            unitPriceCents: 100,
          },
        ],
        expectedTotalCents: 100,
        shipping: null,
      },
    });
    expect(hash(deliveryAddress)).toBe(
      createHash('sha256').update(canonical).digest('hex'),
    );
  });
  it.each(Object.keys(address))(
    'includes corrected address field %s',
    (field) => {
      const changed = correction();
      Object.assign(changed.address, { [field]: 'Changed' });
      expect(hash(changed)).not.toBe(hash(correction()));
    },
  );
  it.each([
    { mode: 'newSaved' },
    { addressId: '00000000-0000-4000-8000-000000000002' },
    { expectedVersion: '2026-10-15T00:00:00.000Z' },
  ])('includes correction identity %j', (change) => {
    expect(hash({ ...correction(), ...change })).not.toBe(hash(correction()));
  });
  it('normalizes optional omitted fields to null without trimming saved text', () => {
    expect(hash({ ...correction(), address: { street: 'Street' } })).toBe(
      hash({ ...correction(), address: { street: 'Street', label: null } }),
    );
    expect(hash({ ...correction(), address: { street: ' Street ' } })).not.toBe(
      hash({ ...correction(), address: { street: 'Street' } }),
    );
  });
});

// shipping-zones / T7 (S8, S10) — sale.shipping { quoteId } | { mode: "pickup" }.
describe('Checkout backend shipping', () => {
  const QUOTE = `shq_${'Q'.repeat(43)}`;
  const location = {
    name: 'Sucursal Centro',
    address: null,
    hours: null,
  };

  function harness(options: {
    verify?: jest.Mock<Promise<unknown>, [string, unknown]>;
    existingCustomer?: boolean;
  }) {
    const receiptCreate = jest.fn<unknown, [unknown]>();
    const addressCreate = jest
      .fn<Promise<unknown>, [unknown]>()
      .mockResolvedValue({
        id: 'address-1',
        updatedAt: new Date(version),
        ...address,
      });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]),
      saleIdempotency: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: receiptCreate,
      },
      tenantMembership: { findFirst: jest.fn().mockResolvedValue({ id }) },
      customer: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            options.existingCustomer
              ? [{ id, firstName: 'Ana', lastName: null }]
              : [],
          ),
        create: jest
          .fn()
          .mockResolvedValue({ id, firstName: 'Ana', lastName: null }),
      },
      customerAddress: {
        create: addressCreate,
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const tenant = {
      getTenantId: () => 'tenant-1',
      getClient: () => tx,
      runInTransaction: jest.fn((work: () => Promise<unknown>) => work()),
    };
    const confirmBotSale = jest
      .fn<Promise<unknown>, [unknown]>()
      .mockResolvedValue({
        saleId: 'sale-1',
        folio: 'A-1',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 3100,
        discountCents: 0,
        paidCents: 0,
        debtCents: 3100,
        confirmedAt: version,
      });
    const verify =
      options.verify ??
      jest.fn<Promise<unknown>, [string, unknown]>().mockResolvedValue({
        status: 'OK',
        quote: {
          id: 'quote-row-1',
          costCents: 3000,
          creditCents: 0,
          customerChargeCents: 3000,
          currency: 'MXN',
          expiresAt: new Date(),
        },
      });
    const resolve = jest
      .fn<Promise<unknown>, [string]>()
      .mockResolvedValue(location);
    const service = new CheckoutService(
      tenant as never,
      { confirmBotSale } as never,
      { get: () => 50000 } as never,
      { verify } as never,
      { resolve } as never,
    );
    return {
      service,
      confirmBotSale,
      verify,
      resolve,
      receiptCreate,
      addressCreate,
    };
  }

  const request = (shipping: unknown, deliveryAddress?: object) =>
    plainToInstance(CheckoutRequestDto, {
      ...input(deliveryAddress ?? { mode: 'newSaved', address }),
      ...(deliveryAddress === undefined &&
      (shipping as { mode?: string })?.mode === 'pickup'
        ? { deliveryAddress: undefined }
        : {}),
      customer: { mode: 'createIfAbsent', firstName: 'Ana' },
      sale: { ...input({}).sale, expectedTotalCents: 3100, shipping },
    });

  it('verifies the quote against tenant, phone, lines and the saved address, then charges it', async () => {
    const h = harness({});

    const result = await h.service.create(request({ quoteId: QUOTE }), 'k1');

    expect(h.verify.mock.calls[0]).toEqual([
      QUOTE,
      {
        tenantId: 'tenant-1',
        customer: { phoneCountryCode: '52', phone: '5512345678' },
        lines: [{ productId: id, variantId: null, quantity: 1 }],
        destination: {
          zipCode: '64000',
          state: 'Nuevo León',
          municipality: 'Monterrey',
          neighborhood: 'Centro',
        },
      },
    ]);
    const confirmInput = h.confirmBotSale.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(confirmInput).toMatchObject({
      shippingAddressId: 'address-1',
      shippingQuote: { quoteRecordId: 'quote-row-1', chargeCents: 3000 },
      fulfillmentMode: 'DELIVERY',
      expectedTotalCents: 3100,
    });
    expect(confirmInput.shipping).toBeUndefined();
    expect(result).not.toHaveProperty('pickupLocation');
    expect(h.receiptCreate.mock.calls).toHaveLength(1);
  });

  it.each([
    [{ status: 'NOT_FOUND' }, 404, 'SHIPPING_QUOTE_NOT_FOUND', undefined],
    [{ status: 'EXPIRED' }, 409, 'SHIPPING_QUOTE_EXPIRED', undefined],
    [
      { status: 'MISMATCH', mismatches: ['CUSTOMER', 'LINES'] },
      409,
      'SHIPPING_QUOTE_MISMATCH',
      ['CUSTOMER', 'LINES'],
    ],
  ])(
    'rejects %j before the sale and without a receipt',
    async (outcome, status, code, mismatches) => {
      const h = harness({
        verify: jest
          .fn<Promise<unknown>, [string, unknown]>()
          .mockResolvedValue(outcome),
      });

      const error = (await h.service
        .create(request({ quoteId: QUOTE }), 'k2')
        .catch((caught: unknown) => caught)) as {
        getStatus: () => number;
        getResponse: () => Record<string, unknown>;
      };

      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toEqual({
        statusCode: status,
        error: code,
        message: code,
        ...(mismatches ? { mismatches } : {}),
      });
      expect(h.confirmBotSale.mock.calls).toHaveLength(0);
      expect(h.receiptCreate.mock.calls).toHaveLength(0);
    },
  );

  it('registers a pickup without an address and returns the pickup location', async () => {
    const h = harness({});
    const pickupRequest = plainToInstance(CheckoutRequestDto, {
      phoneCountryCode: '52',
      phone: '5512345678',
      customer: { mode: 'createIfAbsent', firstName: 'Ana' },
      sale: { ...input({}).sale, shipping: { mode: 'pickup' } },
    });

    const result = await h.service.create(pickupRequest, 'k3');

    expect(h.addressCreate.mock.calls).toHaveLength(0);
    expect(h.verify.mock.calls).toHaveLength(0);
    expect(h.confirmBotSale.mock.calls[0]?.[0]).toMatchObject({
      shippingAddressId: null,
      fulfillmentMode: 'PICKUP',
    });
    expect(h.resolve.mock.calls[0]).toEqual(['tenant-1']);
    expect(result).toMatchObject({
      address: null,
      pickupLocation: location,
    });
    const receipt = h.receiptCreate.mock.calls[0]?.[0] as {
      data: { responseJson: Record<string, unknown> };
    };
    expect(receipt.data.responseJson.pickupLocation).toEqual(location);
  });

  it('accepts an existing customer for pickup with customerId only', async () => {
    const h = harness({ existingCustomer: true });
    const pickupRequest = plainToInstance(CheckoutRequestDto, {
      phoneCountryCode: '52',
      phone: '5512345678',
      customer: { mode: 'existing', customerId: id },
      sale: { ...input({}).sale, shipping: { mode: 'pickup' } },
    });

    const result = await h.service.create(pickupRequest, 'k4');

    expect(result.customer).toMatchObject({
      resolution: 'existing',
      customerId: id,
    });
    expect(result.address).toBeNull();
  });

  it('hashes quote, pickup and no shipping differently', () => {
    const base = input({ mode: 'newSaved', address });
    const of = (shipping: unknown) =>
      computeCheckoutRequestHash(
        plainToInstance(CheckoutRequestDto, {
          ...base,
          sale: { ...base.sale, ...(shipping ? { shipping } : {}) },
        }),
      );
    const hashes = new Set([
      of(undefined),
      of({ quoteId: QUOTE }),
      of({ quoteId: `shq_${'R'.repeat(43)}` }),
      of({ mode: 'pickup' }),
    ]);
    expect(hashes.size).toBe(4);
  });
});
