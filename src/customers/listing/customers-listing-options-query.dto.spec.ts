import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CustomersListingOptionField,
  CustomersListingOptionsQueryDto,
} from './customers-listing-options-query.dto';

/** Same options as the global pipe (`createAppValidationPipe`). */
async function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(CustomersListingOptionsQueryDto, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

describe('CustomersListingOptionsQueryDto (contract §5, §11)', () => {
  it('fields are exactly the §5 list (no preferredPaymentMethod, no zone)', () => {
    expect(Object.values(CustomersListingOptionField)).toEqual([
      'neighborhood',
      'municipality',
      'city',
      'zipCode',
      'fiscalRegime',
    ]);
  });

  it('defaults: limit 50, no q', async () => {
    const { dto, errors } = await parse({ field: 'neighborhood' });
    expect(errors).toEqual([]);
    expect(dto.limit).toBe(50);
    expect(dto.q).toBeUndefined();
  });

  it('accepts q and limit 1–200', async () => {
    for (const limit of ['1', '200']) {
      const { dto, errors } = await parse({
        field: 'city',
        q: 'méx',
        limit,
      });
      expect(errors).toEqual([]);
      expect(dto.limit).toBe(Number(limit));
      expect(dto.q).toBe('méx');
    }
  });

  it.each([
    [{}, 'field'],
    [{ field: 'preferredPaymentMethod' }, 'field'],
    [{ field: 'deliveryZoneType' }, 'field'],
    [{ field: 'state' }, 'field'],
    [{ field: 'city', limit: '0' }, 'limit'],
    [{ field: 'city', limit: '201' }, 'limit'],
    [{ field: 'city', limit: '2.5' }, 'limit'],
    [{ field: 'city', q: ['a', 'b'] }, 'q'],
    [{ field: 'city', page: '2' }, 'page'],
  ])('%j → standard validation error on %s', async (query, property) => {
    const { errors } = await parse(query);
    expect(errors.map((e) => e.property)).toEqual([property]);
  });
});
