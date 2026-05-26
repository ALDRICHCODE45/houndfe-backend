import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DateRange } from './date-range.decorator';

class DateRangeDto {
  @DateRange({ field: 'confirmedAt', peer: 'confirmedTo', role: 'from' })
  confirmedFrom?: Date;

  @DateRange({ field: 'confirmedAt', peer: 'confirmedFrom', role: 'to' })
  confirmedTo?: Date;
}

describe('@DateRange', () => {
  it('accepts valid from/to values', async () => {
    const dto = plainToInstance(DateRangeDto, {
      confirmedFrom: '2026-06-01T00:00:00Z',
      confirmedTo: '2026-06-02T00:00:00Z',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.confirmedFrom).toBeInstanceOf(Date);
  });

  it('rejects malformed dates', async () => {
    const dto = plainToInstance(DateRangeDto, {
      confirmedFrom: 'not-a-date',
    });
    const errors = await validate(dto);

    expect(errors[0].contexts?.listingInvalidDate?.code).toBe(
      'LISTING_INVALID_DATE',
    );
  });

  it('rejects inverted ranges', async () => {
    const dto = plainToInstance(DateRangeDto, {
      confirmedFrom: '2026-06-03T00:00:00Z',
      confirmedTo: '2026-06-01T00:00:00Z',
    });
    const errors = await validate(dto);

    expect(errors[0].contexts?.listingInvertedRange?.code).toBe(
      'LISTING_INVERTED_RANGE',
    );
  });
});
