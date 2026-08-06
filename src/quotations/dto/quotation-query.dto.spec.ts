import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListQuotationsStatus, QuotationQueryDto } from './quotation-query.dto';

describe('QuotationQueryDto', () => {
  const makeDto = (payload: Record<string, unknown>) =>
    plainToInstance(QuotationQueryDto, payload);

  it('applies defaults when query is omitted', async () => {
    const dto = plainToInstance(QuotationQueryDto, {});

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.sortBy).toBe('createdAt');
    expect(dto.sortOrder).toBe('desc');
  });

  describe('status CSV multi-value', () => {
    it('parses a CSV of two statuses into an array', async () => {
      const dto = makeDto({ status: 'DRAFT,SENT' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.status).toEqual([
        ListQuotationsStatus.DRAFT,
        ListQuotationsStatus.SENT,
      ]);
    });

    it('accepts a single status value (backward compat)', async () => {
      const dto = makeDto({ status: 'DRAFT' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.status).toEqual([ListQuotationsStatus.DRAFT]);
    });

    it('rejects an invalid status value', async () => {
      const dto = makeDto({ status: 'DRAFT,NOT_A_STATUS' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('status');
      expect(errors[0].contexts?.listingInvalidEnumValue?.code).toBe(
        'LISTING_INVALID_ENUM_VALUE',
      );
    });
  });

  describe('customerId CSV multi-value', () => {
    it('parses a CSV of two uuids into an array', async () => {
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

    it('accepts a single uuid value', async () => {
      const dto = makeDto({
        customerId: '550e8400-e29b-41d4-a716-446655440001',
      });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.customerId).toEqual(['550e8400-e29b-41d4-a716-446655440001']);
    });

    it('rejects an invalid uuid value', async () => {
      const dto = makeDto({
        customerId: '550e8400-e29b-41d4-a716-446655440001,not-a-uuid',
      });
      const errors = await validate(dto);

      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('customerId');
      expect(errors[0].contexts?.listingInvalidUuid?.code).toBe(
        'LISTING_INVALID_UUID',
      );
    });
  });

  describe('search', () => {
    it('accepts a search string', async () => {
      const dto = makeDto({ search: '  Maria  ' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.search).toBe('  Maria  ');
    });
  });

  describe('total cents range', () => {
    it('accepts minTotalCents=0 as a valid bound', async () => {
      const dto = makeDto({ minTotalCents: '0' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.minTotalCents).toBe(0);
    });

    it('accepts maxTotalCents=0 as a valid bound', async () => {
      const dto = makeDto({ maxTotalCents: '0' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.maxTotalCents).toBe(0);
    });

    it('accepts a min/max range', async () => {
      const dto = makeDto({ minTotalCents: '100', maxTotalCents: '5000' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.minTotalCents).toBe(100);
      expect(dto.maxTotalCents).toBe(5000);
    });

    it('rejects an inverted min/max range', async () => {
      const dto = makeDto({ minTotalCents: '10', maxTotalCents: '5' });
      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('minTotalCents');
      expect(errors[0].contexts?.listingInvertedRange?.code).toBe(
        'LISTING_INVERTED_RANGE',
      );
    });

    it('rejects a non-numeric total value', async () => {
      const dto = makeDto({ minTotalCents: 'abc' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('minTotalCents');
      expect(errors[0].contexts?.listingInvalidNumber?.code).toBe(
        'LISTING_INVALID_NUMBER',
      );
    });
  });

  describe('expiry range', () => {
    it('accepts expiresFrom without expiresTo', async () => {
      const dto = makeDto({ expiresFrom: '2026-07-01T00:00:00.000Z' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.expiresFrom).toBeInstanceOf(Date);
      expect(dto.expiresTo).toBeUndefined();
    });

    it('accepts expiresTo without expiresFrom', async () => {
      const dto = makeDto({ expiresTo: '2026-07-31T00:00:00.000Z' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.expiresFrom).toBeUndefined();
      expect(dto.expiresTo).toBeInstanceOf(Date);
    });

    it('rejects an inverted expiry range', async () => {
      const dto = makeDto({
        expiresFrom: '2026-12-31T00:00:00.000Z',
        expiresTo: '2026-01-01T00:00:00.000Z',
      });
      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('expiresFrom');
      expect(errors[0].contexts?.listingInvertedRange?.code).toBe(
        'LISTING_INVERTED_RANGE',
      );
    });

    it('rejects an invalid date value', async () => {
      const dto = makeDto({ expiresFrom: 'garbage' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('expiresFrom');
      expect(errors[0].contexts?.listingInvalidDate?.code).toBe(
        'LISTING_INVALID_DATE',
      );
    });
  });

  describe('empty-string values are treated as absent', () => {
    it('normalizes empty status to an empty array', async () => {
      const dto = makeDto({ status: '' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.status).toEqual([]);
    });

    it('normalizes empty customerId to an empty array', async () => {
      const dto = makeDto({ customerId: '' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.customerId).toEqual([]);
    });

    it('drops empty-string minTotalCents', async () => {
      const dto = makeDto({ minTotalCents: '' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.minTotalCents).toBeUndefined();
    });

    it('drops empty-string expiresFrom', async () => {
      const dto = makeDto({ expiresFrom: '' });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.expiresFrom).toBeUndefined();
    });
  });
});
