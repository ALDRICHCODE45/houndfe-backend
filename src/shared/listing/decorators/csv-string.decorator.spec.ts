import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CsvString } from './csv-string.decorator';

class CsvStringDto {
  @CsvString({ field: 'folio', max: 2 })
  folio?: string[];
}

describe('@CsvString', () => {
  it('parses, trims and deduplicates values', async () => {
    const dto = plainToInstance(CsvStringDto, { folio: ' A-1 , B-2 , A-1 ' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.folio).toEqual(['A-1', 'B-2']);
  });

  it('accepts blank input as empty list', async () => {
    const dto = plainToInstance(CsvStringDto, { folio: '' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.folio).toEqual([]);
  });

  it('rejects when cap is exceeded', async () => {
    const dto = plainToInstance(CsvStringDto, { folio: 'A-1,B-2,C-3' });
    const errors = await validate(dto);

    expect(errors[0].property).toBe('folio');
    expect(errors[0].contexts?.listingTooManyValues?.code).toBe(
      'LISTING_TOO_MANY_VALUES',
    );
  });
});
