import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CsvEnum } from './csv-enum.decorator';

enum PaymentStatus {
  PAID = 'PAID',
  PARTIAL = 'PARTIAL',
  CREDIT = 'CREDIT',
}

class CsvEnumDto {
  @CsvEnum(PaymentStatus, { field: 'paymentStatus', max: 2 })
  paymentStatus?: PaymentStatus[];
}

describe('@CsvEnum', () => {
  it('parses valid csv enum values', async () => {
    const dto = plainToInstance(CsvEnumDto, { paymentStatus: 'PAID,CREDIT' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.paymentStatus).toEqual(['PAID', 'CREDIT']);
  });

  it('rejects unknown enum values', async () => {
    const dto = plainToInstance(CsvEnumDto, { paymentStatus: 'PAID,INVALID' });
    const errors = await validate(dto);

    expect(errors[0].property).toBe('paymentStatus');
    expect(errors[0].contexts?.listingInvalidEnumValue?.code).toBe(
      'LISTING_INVALID_ENUM_VALUE',
    );
  });

  it('rejects when cap is exceeded', async () => {
    const dto = plainToInstance(CsvEnumDto, {
      paymentStatus: 'PAID,PARTIAL,CREDIT',
    });
    const errors = await validate(dto);

    expect(errors[0].property).toBe('paymentStatus');
    expect(errors[0].contexts?.listingTooManyValues?.code).toBe(
      'LISTING_TOO_MANY_VALUES',
    );
  });
});
