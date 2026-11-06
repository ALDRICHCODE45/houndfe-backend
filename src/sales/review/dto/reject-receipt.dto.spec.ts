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

  it('keeps the v1 body valid: customerReason is optional', async () => {
    const dto = toDto({ reason: 'Monto no coincide' });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.customerReason).toBeUndefined();
  });

  it('accepts and trims a customer-safe reason up to 300 chars', async () => {
    const dto = toDto({
      reason: 'internal',
      customerReason: '  El monto no coincide con tu pedido.  ',
    });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.customerReason).toBe('El monto no coincide con tu pedido.');
    expect(
      await validate(toDto({ reason: 'x', customerReason: 'a'.repeat(300) })),
    ).toHaveLength(0);
  });

  it.each([
    ['blank', '   '],
    ['too long', 'a'.repeat(301)],
    ['not a string', 42],
  ])('rejects a %s customerReason', async (_label, customerReason) => {
    const errors = await validate(toDto({ reason: 'x', customerReason }));

    expect(errors.length).toBeGreaterThan(0);
  });
});
