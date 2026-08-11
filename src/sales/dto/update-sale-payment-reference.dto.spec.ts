import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSalePaymentReferenceDto } from './update-sale-payment-reference.dto';

const toDto = (payload: Record<string, unknown>) =>
  plainToInstance(UpdateSalePaymentReferenceDto, payload);

describe('UpdateSalePaymentReferenceDto', () => {
  it('accepts a reference string', async () => {
    const dto = toDto({ reference: 'TRF-123' });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('accepts an empty string reference (treated as clear by the service)', async () => {
    const dto = toDto({ reference: '' });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('accepts explicit null reference (clear)', async () => {
    const dto = toDto({ reference: null });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects non-string, non-null reference values', async () => {
    const dto = toDto({ reference: 1234 });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });
});
