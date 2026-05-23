import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListSalesDeliveryStatus,
  ListSalesPaymentStatus,
  ListSalesPaymentMethod,
  ListSalesQueryDto,
  ListSalesStatus,
} from './list-sales-query.dto';

describe('ListSalesQueryDto', () => {
  const makeDto = (payload: Record<string, unknown>) =>
    plainToInstance(ListSalesQueryDto, payload);

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
    dto.resolveLegacyAlias();

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

  describe('multi-value fields', () => {
    it('accepts paymentStatus csv with two values', async () => {
      const dto = makeDto({ paymentStatus: 'PAID,PARTIAL' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.paymentStatus).toEqual([
        ListSalesPaymentStatus.PAID,
        ListSalesPaymentStatus.PARTIAL,
      ]);
    });

    it('accepts paymentStatus with a single value', async () => {
      const dto = makeDto({ paymentStatus: 'PAID' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.paymentStatus).toEqual([ListSalesPaymentStatus.PAID]);
    });

    it('normalizes empty paymentStatus as empty array', async () => {
      const dto = makeDto({ paymentStatus: '' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.paymentStatus).toEqual([]);
    });

    it('rejects paymentStatus containing unknown enum value', async () => {
      const dto = makeDto({ paymentStatus: 'PAID,INVALID' });
      const errors = await validate(dto);

      expect(errors[0].property).toBe('paymentStatus');
      expect(errors[0].contexts?.listingInvalidEnumValue?.code).toBe(
        'LISTING_INVALID_ENUM_VALUE',
      );
    });

    it('rejects folio when cardinality cap is exceeded', async () => {
      const folios = Array.from({ length: 201 }, (_, i) => `F-${i + 1}`);
      const dto = makeDto({ folio: folios.join(',') });
      const errors = await validate(dto);

      expect(errors[0].property).toBe('folio');
      expect(errors[0].contexts?.listingTooManyValues?.code).toBe('LISTING_TOO_MANY_VALUES');
    });

    it('accepts status single value csv', async () => {
      const dto = makeDto({ status: 'CONFIRMED' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.status).toEqual([ListSalesStatus.CONFIRMED]);
    });

    it('accepts paymentMethod csv with two enum values', async () => {
      const dto = makeDto({ paymentMethod: 'CASH,TRANSFER' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.paymentMethod).toEqual([
        ListSalesPaymentMethod.CASH,
        ListSalesPaymentMethod.TRANSFER,
      ]);
    });

    it('accepts deliveryStatus single value csv', async () => {
      const dto = makeDto({ deliveryStatus: 'NOT_APPLICABLE' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.deliveryStatus).toEqual([ListSalesDeliveryStatus.NOT_APPLICABLE]);
    });

    it('accepts customerId csv with two uuids', async () => {
      const dto = makeDto({
        customerId:
          '550e8400-e29b-41d4-a716-446655440001,550e8400-e29b-41d4-a716-446655440002',
      });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.customerId).toEqual([
        '550e8400-e29b-41d4-a716-446655440001',
        '550e8400-e29b-41d4-a716-446655440002',
      ]);
    });

    it('rejects customerId when cardinality cap is exceeded', async () => {
      const uuids = Array.from(
        { length: 201 },
        (_, i) => `550e8400-e29b-41d4-a716-${(446655440000 + i).toString().padStart(12, '0')}`,
      );
      const dto = makeDto({ customerId: uuids.join(',') });
      const errors = await validate(dto);

      expect(errors[0].property).toBe('customerId');
      expect(errors[0].contexts?.listingTooManyValues?.code).toBe('LISTING_TOO_MANY_VALUES');
    });

    it('accepts cashierUserId csv with two uuids', async () => {
      const dto = makeDto({
        cashierUserId:
          '550e8400-e29b-41d4-a716-446655440000,550e8400-e29b-41d4-a716-446655440003',
      });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.cashierUserId).toEqual([
        '550e8400-e29b-41d4-a716-446655440000',
        '550e8400-e29b-41d4-a716-446655440003',
      ]);
    });

    it('rejects cashierUserId when cardinality cap is exceeded', async () => {
      const uuids = Array.from(
        { length: 201 },
        (_, i) => `550e8400-e29b-41d4-a716-${(446655440000 + i).toString().padStart(12, '0')}`,
      );
      const dto = makeDto({ cashierUserId: uuids.join(',') });
      const errors = await validate(dto);

      expect(errors[0].property).toBe('cashierUserId');
      expect(errors[0].contexts?.listingTooManyValues?.code).toBe('LISTING_TOO_MANY_VALUES');
    });

    it('accepts folio csv values', async () => {
      const dto = makeDto({ folio: 'F-001,F-002' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.folio).toEqual(['F-001', 'F-002']);
    });
  });

  describe('numeric ranges', () => {
    it('accepts totalMin without totalMax', async () => {
      const dto = makeDto({ totalMin: '5000' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.totalMin).toBe(5000);
      expect(dto.totalMax).toBeUndefined();
    });

    it('accepts totalMax without totalMin', async () => {
      const dto = makeDto({ totalMax: '20000' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.totalMin).toBeUndefined();
      expect(dto.totalMax).toBe(20000);
    });

    it('accepts zero boundaries for total range', async () => {
      const dto = makeDto({ totalMin: '0', totalMax: '0' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.totalMin).toBe(0);
      expect(dto.totalMax).toBe(0);
    });

    it('accepts debt range with min and max', async () => {
      const dto = makeDto({ debtMin: '5000', debtMax: '20000' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.debtMin).toBe(5000);
      expect(dto.debtMax).toBe(20000);
    });

    it('rejects debt range when min is greater than max', async () => {
      const dto = makeDto({ debtMin: '20000', debtMax: '5000' });
      const errors = await validate(dto);

      expect(errors[0].property).toBe('debtMin');
      expect(errors[0].contexts?.listingInvertedRange?.code).toBe('LISTING_INVERTED_RANGE');
    });

    it('accepts zero boundaries for debt range', async () => {
      const dto = makeDto({ debtMin: '0', debtMax: '0' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.debtMin).toBe(0);
      expect(dto.debtMax).toBe(0);
    });
  });

  describe('date ranges', () => {
    it('accepts confirmedFrom without confirmedTo', async () => {
      const dto = makeDto({ confirmedFrom: '2026-01-01' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.confirmedFrom).toBeInstanceOf(Date);
      expect(dto.confirmedTo).toBeUndefined();
    });

    it('accepts confirmedTo without confirmedFrom', async () => {
      const dto = makeDto({ confirmedTo: '2026-12-31' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.confirmedFrom).toBeUndefined();
      expect(dto.confirmedTo).toBeInstanceOf(Date);
    });

    it('rejects inverted confirmed date range', async () => {
      const dto = makeDto({
        confirmedFrom: '2026-12-31',
        confirmedTo: '2026-01-01',
      });
      const errors = await validate(dto);

      expect(errors[0].property).toBe('confirmedFrom');
      expect(errors[0].contexts?.listingInvertedRange?.code).toBe('LISTING_INVERTED_RANGE');
    });

    it('rejects malformed confirmedFrom date', async () => {
      const dto = makeDto({ confirmedFrom: 'garbage' });
      const errors = await validate(dto);

      expect(errors[0].property).toBe('confirmedFrom');
      expect(errors[0].contexts?.listingInvalidDate?.code).toBe('LISTING_INVALID_DATE');
    });

    it('accepts dueDateFrom without dueDateTo', async () => {
      const dto = makeDto({ dueDateFrom: '2026-01-01' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.dueDateFrom).toBeInstanceOf(Date);
      expect(dto.dueDateTo).toBeUndefined();
    });

    it('accepts dueDateTo without dueDateFrom', async () => {
      const dto = makeDto({ dueDateTo: '2026-12-31' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.dueDateFrom).toBeUndefined();
      expect(dto.dueDateTo).toBeInstanceOf(Date);
    });

    it('rejects inverted dueDate range', async () => {
      const dto = makeDto({
        dueDateFrom: '2026-12-31',
        dueDateTo: '2026-01-01',
      });
      const errors = await validate(dto);

      expect(errors[0].property).toBe('dueDateFrom');
      expect(errors[0].contexts?.listingInvertedRange?.code).toBe('LISTING_INVERTED_RANGE');
    });

    it('rejects malformed dueDateFrom date', async () => {
      const dto = makeDto({ dueDateFrom: 'garbage' });
      const errors = await validate(dto);

      expect(errors[0].property).toBe('dueDateFrom');
      expect(errors[0].contexts?.listingInvalidDate?.code).toBe('LISTING_INVALID_DATE');
    });
  });

  describe('boolean include-null flags', () => {
    it('parses include-null flags as true', async () => {
      const dto = makeDto({
        customerIncludeNull: 'true',
        paymentMethodIncludeNull: 'true',
        dueDateIncludeNull: 'true',
      });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.customerIncludeNull).toBe(true);
      expect(dto.paymentMethodIncludeNull).toBe(true);
      expect(dto.dueDateIncludeNull).toBe(true);
    });

    it('parses include-null flags as false', async () => {
      const dto = makeDto({
        customerIncludeNull: 'false',
        paymentMethodIncludeNull: 'false',
        dueDateIncludeNull: 'false',
      });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.customerIncludeNull).toBe(false);
      expect(dto.paymentMethodIncludeNull).toBe(false);
      expect(dto.dueDateIncludeNull).toBe(false);
    });

    it('rejects empty-string customerIncludeNull value', async () => {
      const dto = makeDto({ customerIncludeNull: '' });
      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('customerIncludeNull');
    });

    it('rejects empty-string paymentMethodIncludeNull value', async () => {
      const dto = makeDto({ paymentMethodIncludeNull: '' });
      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('paymentMethodIncludeNull');
    });

    it('rejects empty-string dueDateIncludeNull value', async () => {
      const dto = makeDto({ dueDateIncludeNull: '' });
      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('dueDateIncludeNull');
    });
  });

  describe('deprecated from/to aliases', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('maps legacy from alias to confirmedFrom and warns once', async () => {
      const dto = makeDto({ from: '2026-01-01T00:00:00.000Z' });
      const errors = await validate(dto);
      dto.resolveLegacyAlias();

      expect(errors).toHaveLength(0);
      expect(dto.confirmedFrom?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps confirmedFrom when both confirmedFrom and from are present and warns', async () => {
      const dto = makeDto({
        confirmedFrom: '2026-02-01T00:00:00.000Z',
        from: '2026-01-01T00:00:00.000Z',
      });
      const errors = await validate(dto);
      dto.resolveLegacyAlias();

      expect(errors).toHaveLength(0);
      expect(dto.confirmedFrom?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not warn when only confirmedFrom is used', async () => {
      const dto = makeDto({ confirmedFrom: '2026-02-01T00:00:00.000Z' });
      const errors = await validate(dto);
      dto.resolveLegacyAlias();

      expect(errors).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
