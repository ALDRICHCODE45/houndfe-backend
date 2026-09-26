import { ValidationPipe } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { CreateAddressDto, UpdateAddressDto } from './address.dto';
import { CreateCustomerDto } from './create-customer.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validateBody = (value: unknown, metatype: Type<unknown>) =>
  pipe.transform(value, { type: 'body', metatype });

describe('customer address coordinate transport', () => {
  for (const dto of [CreateAddressDto, UpdateAddressDto]) {
    const base = dto === CreateAddressDto ? { street: 'Main St' } : {};
    it.each([
      ['omitted', {}, true],
      ['both null', { latitude: null, longitude: null }, true],
      ['zero and limits', { latitude: 0, longitude: -180 }, true],
      ['positive limits', { latitude: 90, longitude: 180 }, true],
      ['latitude only', { latitude: 1 }, false],
      ['longitude only', { longitude: 1 }, false],
      ['mixed null', { latitude: null, longitude: 1 }, false],
      ['undefined and number', { latitude: undefined, longitude: 1 }, false],
      ['string', { latitude: '1', longitude: 2 }, false],
      ['nonfinite', { latitude: Infinity, longitude: 2 }, false],
      ['NaN', { latitude: NaN, longitude: 2 }, false],
      ['latitude out of range', { latitude: 91, longitude: 0 }, false],
      ['longitude out of range', { latitude: 0, longitude: -181 }, false],
    ])('%s on %s', async (_name, coordinates, valid) => {
      const body = { ...base, ...coordinates };
      if (valid) {
        await expect(validateBody(body, dto)).resolves.toMatchObject(body);
      } else {
        await expect(validateBody(body, dto)).rejects.toMatchObject({
          status: 400,
        });
      }
    });
  }

  it('rejects invalid nested customer addresses with the same rules', async () => {
    await expect(
      validateBody(
        { firstName: 'Ada', addresses: [{ street: 'Main St', latitude: 0 }] },
        CreateCustomerDto,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      validateBody(
        {
          firstName: 'Ada',
          addresses: [{ street: 'Main St', latitude: 0, longitude: 0 }],
        },
        CreateCustomerDto,
      ),
    ).resolves.toMatchObject({ addresses: [{ latitude: 0, longitude: 0 }] });
  });

  it('rejects null street on PATCH but retains omitted and empty street', async () => {
    await expect(
      validateBody({ street: null }, UpdateAddressDto),
    ).rejects.toMatchObject({ status: 400 });
    await expect(validateBody({}, UpdateAddressDto)).resolves.toMatchObject({});
    await expect(
      validateBody({ street: '  ' }, UpdateAddressDto),
    ).resolves.toMatchObject({ street: '  ' });
  });
});
