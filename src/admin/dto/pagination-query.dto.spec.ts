import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PaginationQueryDto } from './pagination-query.dto';

describe('PaginationQueryDto', () => {
  it('should accept valid sortBy and sortOrder values', async () => {
    const dto = plainToInstance(PaginationQueryDto, {
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('should reject invalid sortBy', async () => {
    const dto = plainToInstance(PaginationQueryDto, { sortBy: 'role' });

    const errors = await validate(dto);
    const sortByErrors = errors.filter((e) => e.property === 'sortBy');

    expect(sortByErrors).toHaveLength(1);
  });

  it('should reject invalid sortOrder', async () => {
    const dto = plainToInstance(PaginationQueryDto, { sortOrder: 'sideways' });

    const errors = await validate(dto);
    const sortOrderErrors = errors.filter((e) => e.property === 'sortOrder');

    expect(sortOrderErrors).toHaveLength(1);
  });

  it('should trim the search term', () => {
    const dto = plainToInstance(PaginationQueryDto, { search: '  alice  ' });

    expect(dto.search).toBe('alice');
  });

  it('should default sortBy to name and sortOrder to asc', () => {
    const dto = plainToInstance(PaginationQueryDto, {});

    expect(dto.sortBy).toBe('name');
    expect(dto.sortOrder).toBe('asc');
  });
});
