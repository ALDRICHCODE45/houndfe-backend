import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CustomersListingQueryDto,
  CustomersListingSortBy,
} from './customers-listing-query.dto';

/** Same options as the global pipe (`createAppValidationPipe`). */
async function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(CustomersListingQueryDto, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

describe('CustomersListingQueryDto (contract §3.2, §3.3, §11)', () => {
  it('defaults: page 1, limit 50, sortBy createdAt, sortOrder desc, no search', async () => {
    const { dto, errors } = await parse({});
    expect(errors).toEqual([]);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(50);
    expect(dto.sortBy).toBe('createdAt');
    expect(dto.sortOrder).toBe('desc');
    expect(dto.search).toBeUndefined();
  });

  it('coerces page/limit from query strings', async () => {
    const { dto, errors } = await parse({ page: '3', limit: '100' });
    expect(errors).toEqual([]);
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(100);
  });

  it.each([
    [{ page: '0' }, 'page'],
    [{ page: '1.5' }, 'page'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ sortBy: 'debt' }, 'sortBy'],
    [{ sortOrder: 'up' }, 'sortOrder'],
    [{ preferredPaymentMethod: 'cash' }, 'preferredPaymentMethod'],
    [{ search: ['a', 'b'] }, 'search'],
  ])('%j → validation error on %s', async (query, property) => {
    const { errors } = await parse(query);
    expect(errors.map((e) => e.property)).toEqual([property]);
  });

  it('accepts every sortBy of §3.3', async () => {
    expect(Object.values(CustomersListingSortBy).sort()).toEqual(
      [
        'averageTicket',
        'createdAt',
        'lastPurchaseAt',
        'name',
        'oldestOverdue',
        'openDebt',
        'salesCount',
        'totalSold',
      ].sort(),
    );
    for (const sortBy of Object.values(CustomersListingSortBy)) {
      for (const sortOrder of ['asc', 'desc']) {
        const { errors } = await parse({ sortBy, sortOrder });
        expect(errors).toEqual([]);
      }
    }
  });
});
