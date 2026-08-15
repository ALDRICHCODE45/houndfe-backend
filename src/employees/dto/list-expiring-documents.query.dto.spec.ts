import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ListExpiringDocumentsQueryDto } from './list-expiring-documents.query.dto';

describe('ListExpiringDocumentsQueryDto', () => {
  it('should default daysUntilExpiry to 30, page to 1, limit to 20, sortBy to expiresAt and sortOrder to asc', () => {
    const dto = plainToInstance(ListExpiringDocumentsQueryDto, {});

    expect(dto.daysUntilExpiry).toBe(30);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.sortBy).toBe('expiresAt');
    expect(dto.sortOrder).toBe('asc');
  });

  it('should coerce numeric strings for daysUntilExpiry, page and limit', () => {
    const dto = plainToInstance(ListExpiringDocumentsQueryDto, {
      daysUntilExpiry: '60',
      page: '2',
      limit: '10',
    });

    expect(dto.daysUntilExpiry).toBe(60);
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(10);
  });

  it('should reject daysUntilExpiry below 1', async () => {
    const dto = plainToInstance(ListExpiringDocumentsQueryDto, {
      daysUntilExpiry: 0,
    });

    const errors = await validate(dto);

    expect(errors.filter((e) => e.property === 'daysUntilExpiry')).toHaveLength(1);
  });

  it('should reject limit above 100', async () => {
    const dto = plainToInstance(ListExpiringDocumentsQueryDto, { limit: 101 });

    const errors = await validate(dto);

    expect(errors.filter((e) => e.property === 'limit')).toHaveLength(1);
  });

  it('should accept valid sortBy and sortOrder values', async () => {
    const dto = plainToInstance(ListExpiringDocumentsQueryDto, {
      sortBy: 'employeeName',
      sortOrder: 'desc',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('should reject invalid sortBy', async () => {
    const dto = plainToInstance(ListExpiringDocumentsQueryDto, {
      sortBy: 'employeeNumber',
    });

    const errors = await validate(dto);
    const sortByErrors = errors.filter((e) => e.property === 'sortBy');

    expect(sortByErrors).toHaveLength(1);
  });

  it('should reject invalid sortOrder', async () => {
    const dto = plainToInstance(ListExpiringDocumentsQueryDto, {
      sortOrder: 'sideways',
    });

    const errors = await validate(dto);
    const sortOrderErrors = errors.filter((e) => e.property === 'sortOrder');

    expect(sortOrderErrors).toHaveLength(1);
  });

  it('should trim the search term', () => {
    const dto = plainToInstance(ListExpiringDocumentsQueryDto, {
      search: '  alice  ',
    });

    expect(dto.search).toBe('alice');
  });
});
