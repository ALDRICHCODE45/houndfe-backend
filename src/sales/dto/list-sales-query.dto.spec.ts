import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListSalesPaymentMethod,
  ListSalesQueryDto,
} from './list-sales-query.dto';

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
      paymentStatus: 'PAID,PARTIAL',
      deliveryStatus: 'DELIVERED',
      paymentMethod: 'CASH,CARD_DEBIT',
      folio: 'A-1, B-2',
      cashierUserId: '550e8400-e29b-41d4-a716-446655440000',
      customerId: '550e8400-e29b-41d4-a716-446655440001',
      customerIncludeNull: 'true',
      paymentMethodIncludeNull: 'true',
      dueDateIncludeNull: 'true',
      totalMin: '100',
      totalMax: '1500',
      debtMin: '0',
      debtMax: '600',
      confirmedFrom: '2026-05-01T00:00:00.000Z',
      confirmedTo: '2026-05-08T00:00:00.000Z',
      dueDateFrom: '2026-06-01T00:00:00.000Z',
      dueDateTo: '2026-06-08T00:00:00.000Z',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(50);
    expect(dto.paymentStatus).toEqual(['PAID', 'PARTIAL']);
    expect(dto.deliveryStatus).toEqual(['DELIVERED']);
    expect(dto.paymentMethod).toEqual([
      ListSalesPaymentMethod.CASH,
      ListSalesPaymentMethod.CARD_DEBIT,
    ]);
    expect(dto.folio).toEqual(['A-1', 'B-2']);
    expect(dto.customerIncludeNull).toBe(true);
    expect(dto.paymentMethodIncludeNull).toBe(true);
    expect(dto.dueDateIncludeNull).toBe(true);
    expect(dto.totalMin).toBe(100);
    expect(dto.totalMax).toBe(1500);
    expect(dto.debtMin).toBe(0);
    expect(dto.debtMax).toBe(600);
    expect(dto.confirmedFrom).toBeInstanceOf(Date);
    expect(dto.confirmedTo).toBeInstanceOf(Date);
    expect(dto.dueDateFrom).toBeInstanceOf(Date);
    expect(dto.dueDateTo).toBeInstanceOf(Date);
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

  it('maps from and to aliases when confirmed fields are absent', async () => {
    const dto = plainToInstance(ListSalesQueryDto, {
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.000Z',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.confirmedFrom).toBeInstanceOf(Date);
    expect(dto.confirmedTo).toBeInstanceOf(Date);
    expect(dto.confirmedFrom?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(dto.confirmedTo?.toISOString()).toBe('2026-06-30T23:59:59.000Z');
  });

  it('prioritizes confirmedFrom and confirmedTo over deprecated aliases', async () => {
    const dto = plainToInstance(ListSalesQueryDto, {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T00:00:00.000Z',
      confirmedFrom: '2026-06-01T00:00:00.000Z',
      confirmedTo: '2026-06-30T00:00:00.000Z',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.confirmedFrom?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(dto.confirmedTo?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  it('rejects payment method values outside allowed enum', async () => {
    const dto = plainToInstance(ListSalesQueryDto, {
      paymentMethod: 'CREDIT',
    });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('paymentMethod');
  });

  it('rejects range when totalMin is greater than totalMax', async () => {
    const dto = plainToInstance(ListSalesQueryDto, {
      totalMin: '200',
      totalMax: '100',
    });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('totalMin');
  });

  it('rejects customerId when csv item is invalid uuid', async () => {
    const dto = plainToInstance(ListSalesQueryDto, {
      customerId: 'not-a-uuid',
    });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('customerId');
  });
});
