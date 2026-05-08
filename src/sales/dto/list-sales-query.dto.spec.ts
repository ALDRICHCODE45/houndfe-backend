import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListSalesQueryDto } from './list-sales-query.dto';

describe('ListSalesQueryDto', () => {
  it('applies defaults when query is omitted', async () => {
    const dto = plainToInstance(ListSalesQueryDto, {});

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.sortBy).toBe('confirmedAt');
    expect(dto.sortOrder).toBe('desc');
  });

  it('accepts valid filters and coercions', async () => {
    const dto = plainToInstance(ListSalesQueryDto, {
      page: '2',
      limit: '50',
      paymentStatus: 'PAID',
      deliveryStatus: 'DELIVERED',
      cashierUserId: '550e8400-e29b-41d4-a716-446655440000',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-08T00:00:00.000Z',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(50);
    expect(dto.from).toBeInstanceOf(Date);
    expect(dto.to).toBeInstanceOf(Date);
  });

  it('rejects limit over 100', async () => {
    const dto = plainToInstance(ListSalesQueryDto, { limit: '101' });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
  });

  it('rejects invalid payment status enum', async () => {
    const dto = plainToInstance(ListSalesQueryDto, { paymentStatus: 'INVALID' });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('paymentStatus');
  });
});
