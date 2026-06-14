import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RejectReceiptDto } from './reject-receipt.dto';

const toDto = (payload: Record<string, unknown>) =>
  plainToInstance(RejectReceiptDto, payload);

describe('RejectReceiptDto', () => {
  it('accepts a non-empty rejection reason', async () => {
    const errors = await validate(toDto({ reason: 'Unreadable receipt' }));

    expect(errors).toHaveLength(0);
  });

  it('rejects missing reason', async () => {
    const errors = await validate(toDto({}));

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty reason', async () => {
    const errors = await validate(toDto({ reason: '' }));

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-string reason', async () => {
    const errors = await validate(toDto({ reason: 123 }));

    expect(errors.length).toBeGreaterThan(0);
  });
});
