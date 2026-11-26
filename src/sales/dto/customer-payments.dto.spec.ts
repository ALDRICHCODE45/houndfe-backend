/**
 * customers-listing T2 (S5, contract §7) — `GET /customers/:customerId/
 * payments?page=&limit=` query validation: `page` ≥ 1 (default 1), `limit`
 * 1–100 (default 50).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CUSTOMER_PAYMENTS_DEFAULT_LIMIT,
  CUSTOMER_PAYMENTS_MAX_LIMIT,
  CustomerPaymentsQueryDto,
} from './customer-payments.dto';

const errorsOf = async (payload: Record<string, unknown>) =>
  (await validate(plainToInstance(CustomerPaymentsQueryDto, payload))).map(
    (error) => error.property,
  );

describe('CustomerPaymentsQueryDto', () => {
  it('defaults to page 1 and limit 50', async () => {
    const dto = plainToInstance(CustomerPaymentsQueryDto, {});

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(50);
    expect(CUSTOMER_PAYMENTS_DEFAULT_LIMIT).toBe(50);
    expect(CUSTOMER_PAYMENTS_MAX_LIMIT).toBe(100);
  });

  it('coerces query strings to integers', async () => {
    const dto = plainToInstance(CustomerPaymentsQueryDto, {
      page: '3',
      limit: '100',
    });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(100);
  });

  it.each([
    [{ page: '0' }, 'page'],
    [{ page: '-1' }, 'page'],
    [{ page: '1.5' }, 'page'],
    [{ page: 'abc' }, 'page'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ limit: '2.5' }, 'limit'],
    [{ limit: 'x' }, 'limit'],
  ])('rejects %j on %s', async (payload, property) => {
    expect(await errorsOf(payload)).toEqual([property]);
  });
});
