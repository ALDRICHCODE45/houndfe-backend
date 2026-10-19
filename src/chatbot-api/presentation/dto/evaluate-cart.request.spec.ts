import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EvaluateCartRequestDto } from './evaluate-cart.request';

const items = [
  {
    productId: 'a8fdbf81-31ee-4f43-8739-0c70c9388d72',
    quantity: 1,
    unitPriceCents: 1000,
  },
];

describe('EvaluateCartRequestDto customer phone', () => {
  it.each([{}, { phoneCountryCode: '52', phone: '5512345678' }])(
    'accepts both or neither: %j',
    async (phone) => {
      expect(
        await validate(
          plainToInstance(EvaluateCartRequestDto, { items, ...phone }),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    { phoneCountryCode: '52' },
    { phone: '5512345678' },
    { phoneCountryCode: '+52', phone: '5512345678' },
    { phoneCountryCode: '52', phone: '55 12345678' },
    { phoneCountryCode: '', phone: '5512345678' },
    { phoneCountryCode: '12345678901', phone: '5512345678' },
    { phoneCountryCode: '52', phone: '1'.repeat(21) },
    { phoneCountryCode: null, phone: null },
    { phoneCountryCode: 52, phone: '5512345678' },
  ])('rejects incomplete or invalid digits: %j', async (phone) => {
    expect(
      await validate(
        plainToInstance(EvaluateCartRequestDto, { items, ...phone }),
      ),
    ).not.toEqual([]);
  });
});
