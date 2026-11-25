/**
 * sales-history-redesign S11 — `GET /customers/:customerId/statement/pdf`
 * query validation: exact local `YYYY-MM-DD` bounds, half-open `[from, to)`
 * (`from < to`), at most 366 days. Bounds stay strings.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CustomerStatementQueryDto,
  MAX_CUSTOMER_STATEMENT_RANGE_DAYS,
} from './customer-statement.dto';

const errorsOf = async (payload: Record<string, unknown>) =>
  (await validate(plainToInstance(CustomerStatementQueryDto, payload))).map(
    (error) => error.property,
  );

describe('CustomerStatementQueryDto', () => {
  it.each([
    ['2026-01-01', '2026-02-01'],
    ['2026-11-25', '2026-11-26'],
    ['2024-02-29', '2024-03-01'],
    ['2025-01-01', '2026-01-02'], // exactly 366 days
  ])('accepts [%s, %s) and keeps strings', async (from, to) => {
    const dto = plainToInstance(CustomerStatementQueryDto, { from, to });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.from).toBe(from);
    expect(dto.to).toBe(to);
  });

  it('caps the span at 366 days', async () => {
    expect(MAX_CUSTOMER_STATEMENT_RANGE_DAYS).toBe(366);
    expect(await errorsOf({ from: '2025-01-01', to: '2026-01-03' })).toEqual([
      'to',
    ]);
  });

  it.each([
    ['2026-02-01', '2026-02-01'],
    ['2026-02-02', '2026-02-01'],
  ])('rejects to <= from ([%s, %s))', async (from, to) => {
    expect(await errorsOf({ from, to })).toEqual(['to']);
  });

  it.each([
    ['2026-2-01', 'from'],
    ['2026-02-30', 'from'],
    ['2025-02-29', 'from'],
    ['0000-01-01', 'from'],
    ['2026-13-01', 'from'],
    ['2026-01-01T00:00:00Z', 'from'],
    ['', 'from'],
  ])('rejects the malformed bound %s', async (bad, property) => {
    expect(await errorsOf({ from: bad, to: '2026-03-01' })).toEqual([
      property,
    ]);
    expect(await errorsOf({ from: '2026-01-01', to: bad })).toEqual(['to']);
  });

  it('requires both bounds', async () => {
    expect(await errorsOf({})).toEqual(['from', 'to']);
    expect(await errorsOf({ from: '2026-01-01' })).toEqual(['to']);
  });
});
