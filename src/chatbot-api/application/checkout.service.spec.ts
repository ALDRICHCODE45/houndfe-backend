import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { createHash } from 'node:crypto';
import { CheckoutRequestDto } from '../presentation/dto/checkout.request';
import { computeCheckoutRequestHash } from './checkout.service';

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
