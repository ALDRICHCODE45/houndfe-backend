import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddSalePaymentDto } from './add-sale-payment.dto';

const toDto = (payload: Record<string, unknown>) =>
  plainToInstance(AddSalePaymentDto, payload);

describe('AddSalePaymentDto', () => {
  it('accepts legacy single-entry shape', async () => {
    const dto = toDto({ method: 'cash', amountCents: 1000 });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('accepts array shape with cash and transfer entries', async () => {
    const dto = toDto({
      payments: [
        { method: 'cash', amountCents: 1000 },
        { method: 'transfer', amountCents: 500, reference: 'TRX-1' },
      ],
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects ambiguous mixed shape (legacy + payments[])', async () => {
    const dto = toDto({
      method: 'cash',
      amountCents: 1000,
      payments: [{ method: 'cash', amountCents: 1000 }],
    });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects empty payments array', async () => {
    const dto = toDto({ payments: [] });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects payments array size above 5 entries', async () => {
    const dto = toDto({
      payments: [
        { method: 'cash', amountCents: 1 },
        { method: 'cash', amountCents: 1 },
        { method: 'cash', amountCents: 1 },
        { method: 'cash', amountCents: 1 },
        { method: 'cash', amountCents: 1 },
        { method: 'cash', amountCents: 1 },
      ],
    });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects disallowed method credit in payments[]', async () => {
    const dto = toDto({ payments: [{ method: 'credit', amountCents: 1000 }] });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects amountCents less than 1 in payments[]', async () => {
    const dto = toDto({ payments: [{ method: 'cash', amountCents: 0 }] });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects non-cash payment without reference', async () => {
    const dto = toDto({ payments: [{ method: 'card_debit', amountCents: 1000 }] });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });
});
