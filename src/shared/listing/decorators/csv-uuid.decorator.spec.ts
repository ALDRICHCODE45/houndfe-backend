import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CsvUuid } from './csv-uuid.decorator';

class CsvUuidDto {
  @CsvUuid({ field: 'customerId', max: 2 })
  customerId?: string[];
}

describe('@CsvUuid', () => {
  it('parses valid UUID csv values', async () => {
    const dto = plainToInstance(CsvUuidDto, {
      customerId:
        '550e8400-e29b-41d4-a716-446655440000,550e8400-e29b-41d4-a716-446655440001',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.customerId).toHaveLength(2);
  });

  it('rejects invalid UUID values', async () => {
    const dto = plainToInstance(CsvUuidDto, {
      customerId: '550e8400-e29b-41d4-a716-446655440000,invalid',
    });
    const errors = await validate(dto);

    expect(errors[0].property).toBe('customerId');
    expect(errors[0].contexts?.listingInvalidUuid?.code).toBe(
      'LISTING_INVALID_UUID',
    );
  });

  it('rejects values over cap', async () => {
    const dto = plainToInstance(CsvUuidDto, {
      customerId:
        '550e8400-e29b-41d4-a716-446655440000,550e8400-e29b-41d4-a716-446655440001,550e8400-e29b-41d4-a716-446655440002',
    });
    const errors = await validate(dto);

    expect(errors[0].contexts?.listingTooManyValues?.code).toBe(
      'LISTING_TOO_MANY_VALUES',
    );
  });
});
