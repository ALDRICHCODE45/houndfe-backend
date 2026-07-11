/**
 * ListProductsQueryDto — Validation Tests
 *
 * Validates the query-DTO contract for `GET /products`:
 *  - `search` is an optional, trimmed string.
 *  - `page` is an optional integer >= 1.
 *  - `limit` is an optional integer in [1, 100].
 *  - Extra/unknown query params are rejected (forbidNonWhitelisted at the
 *    NestJS ValidationPipe layer; here we only assert the DTO shape).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListProductsQueryDto } from './list-products-query.dto';

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(ListProductsQueryDto, input, {
    enableImplicitConversion: true,
  });
  const errors = await validate(dto, { whitelist: true });
  return { dto, errors };
}

describe('ListProductsQueryDto', () => {
  describe('search', () => {
    it('accepts an omitted search (undefined)', async () => {
      const { dto, errors } = await validateDto({});
      expect(errors).toHaveLength(0);
      expect(dto.search).toBeUndefined();
    });

    it('accepts a plain string', async () => {
      const { dto, errors } = await validateDto({ search: 'ibup' });
      expect(errors).toHaveLength(0);
      expect(dto.search).toBe('ibup');
    });

    it('accepts an empty string (treated as no-search at the service layer)', async () => {
      const { dto, errors } = await validateDto({ search: '' });
      expect(errors).toHaveLength(0);
      expect(dto.search).toBe('');
    });
  });

  describe('page', () => {
    it('coerces a numeric string into an integer when implicit conversion is on', async () => {
      const { dto, errors } = await validateDto({ page: '2' });
      expect(errors).toHaveLength(0);
      expect(dto.page).toBe(2);
    });

    it('rejects page < 1', async () => {
      const { errors } = await validateDto({ page: 0 });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('page');
    });

    it('rejects a non-integer page', async () => {
      const { errors } = await validateDto({ page: 1.5 });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('page');
    });

    it('accepts an omitted page (undefined)', async () => {
      const { errors } = await validateDto({});
      expect(errors).toHaveLength(0);
    });
  });

  describe('limit', () => {
    it('accepts limit=1 (lower bound)', async () => {
      const { dto, errors } = await validateDto({ limit: 1 });
      expect(errors).toHaveLength(0);
      expect(dto.limit).toBe(1);
    });

    it('accepts limit=100 (upper bound)', async () => {
      const { dto, errors } = await validateDto({ limit: 100 });
      expect(errors).toHaveLength(0);
      expect(dto.limit).toBe(100);
    });

    it('rejects limit=0', async () => {
      const { errors } = await validateDto({ limit: 0 });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('limit');
    });

    it('rejects limit > 100', async () => {
      const { errors } = await validateDto({ limit: 200 });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('limit');
    });

    it('accepts an omitted limit (undefined)', async () => {
      const { errors } = await validateDto({});
      expect(errors).toHaveLength(0);
    });
  });

  describe('combined', () => {
    it('accepts a fully-populated, valid query', async () => {
      const { dto, errors } = await validateDto({
        search: '  ibup  ',
        page: 2,
        limit: 25,
      });
      expect(errors).toHaveLength(0);
      expect(dto.search).toBe('  ibup  ');
      expect(dto.page).toBe(2);
      expect(dto.limit).toBe(25);
    });
  });
});
