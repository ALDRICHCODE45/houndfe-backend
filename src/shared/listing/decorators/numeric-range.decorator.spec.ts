import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NumericRange } from './numeric-range.decorator';

class NumericRangeDto {
  @NumericRange({ field: 'total', peer: 'totalMax', role: 'min' })
  totalMin?: number;

  @NumericRange({ field: 'total', peer: 'totalMin', role: 'max' })
  totalMax?: number;
}

describe('@NumericRange', () => {
  it('accepts valid min/max values', async () => {
    const dto = plainToInstance(NumericRangeDto, {
      totalMin: '100',
      totalMax: '200',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.totalMin).toBe(100);
    expect(dto.totalMax).toBe(200);
  });

  it('rejects non-finite numbers', async () => {
    const dto = plainToInstance(NumericRangeDto, { totalMin: 'not-a-number' });
    const errors = await validate(dto);

    expect(errors[0].contexts?.listingInvalidNumber?.code).toBe(
      'LISTING_INVALID_NUMBER',
    );
  });

  it('rejects inverted ranges', async () => {
    const dto = plainToInstance(NumericRangeDto, {
      totalMin: '300',
      totalMax: '200',
    });
    const errors = await validate(dto);

    expect(errors[0].contexts?.listingInvertedRange?.code).toBe(
      'LISTING_INVERTED_RANGE',
    );
  });
});
