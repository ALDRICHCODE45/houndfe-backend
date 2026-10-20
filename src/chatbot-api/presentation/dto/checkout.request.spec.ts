import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CheckoutRequestDto,
  ExistingCheckoutAddressDto,
  ExistingCheckoutCustomerDto,
  NewCheckoutAddressDto,
  NewCheckoutCustomerDto,
} from './checkout.request';

const id = '00000000-0000-4000-8000-000000000001';
const input = () => ({
  phoneCountryCode: '52',
  phone: '5512345678',
  customer: { mode: 'createIfAbsent', firstName: 'Ana', lastName: null },
  deliveryAddress: { mode: 'newSaved', address: { street: 'Saved Street' } },
  sale: {
    cashierUserId: id,
    items: [
      {
        productId: id,
        productName: 'Item',
        quantity: 1,
        unitPriceCents: 10000,
      },
    ],
    expectedTotalCents: 10000,
  },
});
const check = (value: object) => {
  const before = structuredClone(value);
  const dto = plainToInstance(CheckoutRequestDto, value);
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  expect(value).toEqual(before);
  return { dto, errors };
};

describe('Standalone checkout structural schema', () => {
  it('selects new customer/address variants without requiring saved IDs or mutating input', () => {
    const { dto, errors } = check(input());
    expect(errors).toEqual([]);
    expect(dto.customer).toBeInstanceOf(NewCheckoutCustomerDto);
    expect(dto.deliveryAddress).toBeInstanceOf(NewCheckoutAddressDto);
    expect(dto.customer).toMatchObject({ firstName: 'Ana', lastName: null });
  });
  it('selects existing variants with exact opaque IDs/version and no new-record fields', () => {
    const { dto, errors } = check({
      ...input(),
      customer: { mode: 'existing', customerId: id },
      deliveryAddress: {
        mode: 'existing',
        addressId: id,
        expectedVersion: '2026-10-14T00:00:00.000Z',
      },
    });
    expect(errors).toEqual([]);
    expect(dto.customer).toBeInstanceOf(ExistingCheckoutCustomerDto);
    expect(dto.deliveryAddress).toBeInstanceOf(ExistingCheckoutAddressDto);
    expect(dto.deliveryAddress).toMatchObject({
      addressId: id,
      expectedVersion: '2026-10-14T00:00:00.000Z',
    });
  });
  it('selects existingUpdated with the same nested address schema as newSaved', () => {
    const { dto, errors } = check({
      ...input(),
      deliveryAddress: {
        mode: 'existingUpdated',
        addressId: id,
        expectedVersion: '2026-10-14T00:00:00.000Z',
        address: { street: 'Corrected Street', label: null },
      },
    });
    expect(errors).toEqual([]);
    expect(dto.deliveryAddress.constructor.name).toBe(
      'ExistingUpdatedCheckoutAddressDto',
    );
  });
  it.each([
    { addressId: undefined },
    { addressId: 'invalid' },
    { expectedVersion: undefined },
    { expectedVersion: '2026-10-14T00:00:00Z' },
    { address: undefined },
    { address: null },
    { address: { street: ' ' } },
    { address: { street: 'Street', state: 'invalid' } },
    { address: { street: 'Street', latitude: 1 } },
    { address: { street: 'Street', label: 'x'.repeat(101) } },
  ])('rejects invalid existingUpdated input %j', (change) => {
    expect(
      check({
        ...input(),
        deliveryAddress: {
          mode: 'existingUpdated',
          addressId: id,
          expectedVersion: '2026-10-14T00:00:00.000Z',
          address: { street: 'Street' },
          ...change,
        },
      }).errors.length,
    ).toBeGreaterThan(0);
  });
  it.each([
    { street: 'x'.repeat(201) },
    { street: 'Street', exteriorNumber: 'x'.repeat(21) },
    { street: 'Street', interiorNumber: 'x'.repeat(21) },
    { street: 'Street', zipCode: 'x'.repeat(11) },
    { street: 'Street', neighborhood: 'x'.repeat(101) },
    { street: 'Street', municipality: 'x'.repeat(101) },
    { street: 'Street', city: 'x'.repeat(101) },
    { street: 'Street', visualReferences: 'x'.repeat(501) },
    { street: 'Street', carrierPhone: 'x'.repeat(21) },
    { street: 'Street', state: null, label: null },
  ])('keeps nested validation identical to newSaved for %j', (address) => {
    const saved = check({
      ...input(),
      deliveryAddress: { mode: 'newSaved', address },
    });
    const corrected = check({
      ...input(),
      deliveryAddress: {
        mode: 'existingUpdated',
        addressId: id,
        expectedVersion: '2026-10-14T00:00:00.000Z',
        address,
      },
    });
    expect(corrected.errors.length).toBe(saved.errors.length);
  });
  it('reuses approved-shipping validation without changing omitted-shipping behavior', () => {
    expect(check(input()).errors).toEqual([]);
    const { dto, errors } = check({
      ...input(),
      sale: {
        ...input().sale,
        expectedTotalCents: 10500,
        shipping: {
          chargeCents: 500,
          approvalId: 'approved',
          quoteId: 'quoted',
        },
      },
    });
    expect(errors).toEqual([]);
    expect(dto.sale.shipping).toMatchObject({
      chargeCents: 500,
      approvalId: 'approved',
      quoteId: 'quoted',
    });
  });
  it.each([
    {
      name: 'non-digit trusted phone',
      value: { ...input(), phone: '+5512345678' },
    },
    {
      name: 'unsupported customer variant',
      value: { ...input(), customer: { mode: 'edit', firstName: 'Ana' } },
    },
    {
      name: 'blank new name',
      value: {
        ...input(),
        customer: { mode: 'createIfAbsent', firstName: ' ' },
      },
    },
    {
      name: 'blank new street',
      value: {
        ...input(),
        deliveryAddress: { mode: 'newSaved', address: { street: ' ' } },
      },
    },
    {
      name: 'missing exact version format',
      value: {
        ...input(),
        deliveryAddress: {
          mode: 'existing',
          addressId: id,
          expectedVersion: '2026-10-14T00:00:00Z',
        },
      },
    },
    {
      name: 'empty cart',
      value: { ...input(), sale: { ...input().sale, items: [] } },
    },
    {
      name: 'null optional shipping',
      value: { ...input(), sale: { ...input().sale, shipping: null } },
    },
    {
      name: 'unrequested profile mutation',
      value: {
        ...input(),
        customer: {
          mode: 'createIfAbsent',
          firstName: 'Ana',
          billingAddress: 'Ignored?',
        },
      },
    },
  ])(
    'rejects $name structurally and leaves caller input unchanged',
    ({ value }) => {
      expect(check(value).errors.length).toBeGreaterThan(0);
    },
  );
});
