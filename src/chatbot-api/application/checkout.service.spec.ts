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
