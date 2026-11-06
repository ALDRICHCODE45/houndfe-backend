/**
 * zone-validation-lookup / T1 (S1) — `ListDeliveryZoneValidationsQueryDto`
 * through the same `plainToInstance` + `validate` options as the global
 * `ValidationPipe` (whitelist + forbidNonWhitelisted).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListDeliveryZoneValidationsQueryDto } from './delivery-zone-validation.dto';

async function validateQuery(input: Record<string, unknown>) {
  const dto = plainToInstance(ListDeliveryZoneValidationsQueryDto, input);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

describe('ListDeliveryZoneValidationsQueryDto', () => {
  it('accepts a five-digit zipCode', async () => {
    const { dto, errors } = await validateQuery({ zipCode: '06700' });
    expect(errors).toEqual([]);
    expect(dto.zipCode).toBe('06700');
  });

  it('keeps zipCode optional', async () => {
    const { dto, errors } = await validateQuery({ page: '2', limit: '5' });
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({ page: 2, limit: 5 });
    expect(dto.zipCode).toBeUndefined();
  });

  it.each(['6700', '067000', '06a00', '', ' 06700', '06700 '])(
    'rejects zipCode %p with a value-free message',
    async (zipCode) => {
      const { errors } = await validateQuery({ zipCode });
      expect(errors.map((error) => error.property)).toEqual(['zipCode']);
      expect(errors[0].constraints).toEqual({
        matches: 'zipCode must be exactly five digits',
      });
    },
  );

  it('rejects a repeated zipCode', async () => {
    const { errors } = await validateQuery({ zipCode: ['06700', '03100'] });
    expect(errors.map((error) => error.property)).toEqual(['zipCode']);
  });
});
