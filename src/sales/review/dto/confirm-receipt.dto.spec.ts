import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfirmReceiptDto } from './confirm-receipt.dto';

const toDto = (payload: Record<string, unknown>) =>
  plainToInstance(ConfirmReceiptDto, payload);

describe('ConfirmReceiptDto', () => {
  it('accepts a positive integer confirmed amount', async () => {
    const errors = await validate(toDto({ amountCents: 1500 }));

    expect(errors).toHaveLength(0);
  });

  it('rejects missing amountCents', async () => {
    const errors = await validate(toDto({}));

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects amountCents below one cent', async () => {
    const errors = await validate(toDto({ amountCents: 0 }));

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects non-integer amountCents', async () => {
    const errors = await validate(toDto({ amountCents: 10.5 }));

    expect(errors.length).toBeGreaterThan(0);
  });
});
