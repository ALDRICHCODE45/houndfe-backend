import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListPendingRefundsQueryDto } from './list-pending-refunds-query.dto';

describe('ListPendingRefundsQueryDto', () => {
  const makeDto = (payload: Record<string, unknown>) =>
    plainToInstance(ListPendingRefundsQueryDto, payload);

  it('applies pagination defaults when the query is omitted', async () => {
    const dto = plainToInstance(ListPendingRefundsQueryDto, {});

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('coerces numeric query strings into integers', async () => {
    const dto = makeDto({ page: '3', limit: '50' });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(50);
  });

  it('accepts the maximum page size boundary', async () => {
    const dto = makeDto({ page: '1', limit: '100' });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(100);
  });

  it('rejects a limit above the safe maximum', async () => {
    const dto = makeDto({ limit: '101' });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain('limit');
  });

  it.each([
    ['limit', '0'],
    ['limit', '-1'],
    ['limit', '2.5'],
    ['limit', 'abc'],
    ['page', '0'],
    ['page', '-5'],
    ['page', '1.5'],
    ['page', 'abc'],
  ])('rejects %s=%s', async (property, value) => {
    const dto = makeDto({ [property]: value });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain(property);
  });

  it('keeps defaults when only one bound is supplied', async () => {
    const dto = makeDto({ page: '4' });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(4);
    expect(dto.limit).toBe(20);
  });
});
