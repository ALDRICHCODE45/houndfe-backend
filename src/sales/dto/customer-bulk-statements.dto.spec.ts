/**
 * customers-bulk-actions / T3 (S5) — `POST /customers/bulk/statements` body:
 * the bulk selection plus the single statement's `from` / `to` rules (shared
 * constraints, not copied), through the production validation pipe.
 */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { CustomerStatementQueryDto } from './customer-statement.dto';
import { CustomerBulkStatementsBodyDto } from './customer-bulk-statements.dto';

const pipe = createAppValidationPipe();
const UUID = '3f2a9c1e-0000-4000-8000-000000000001';

const transform = (value: unknown) =>
  pipe.transform(value, {
    type: 'body',
    metatype: CustomerBulkStatementsBodyDto,
  }) as Promise<CustomerBulkStatementsBodyDto>;

async function rejects(value: unknown): Promise<unknown> {
  const error: unknown = await transform(value).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  return (error as BadRequestException).getResponse();
}

const ids = { mode: 'ids', customerIds: [UUID] };

describe('CustomerBulkStatementsBodyDto', () => {
  it('reuses the single statement constraints (extends CustomerStatementQueryDto)', () => {
    expect(Object.getPrototypeOf(CustomerBulkStatementsBodyDto.prototype)).toBe(
      CustomerStatementQueryDto.prototype,
    );
  });

  it.each([
    ['2026-11-01', '2026-12-01'],
    ['2025-01-01', '2026-01-02'], // exactly 366 days
    ['2024-02-29', '2024-03-01'],
  ])('accepts ids mode with [%s, %s) and keeps strings', async (from, to) => {
    const dto = await transform({ selection: ids, from, to });
    expect(dto).toBeInstanceOf(CustomerBulkStatementsBodyDto);
    expect(dto.from).toBe(from);
    expect(dto.to).toBe(to);
    expect(dto.selection.customerIds).toEqual([UUID]);
  });

  it('accepts filter mode with excludeIds', async () => {
    const dto = await transform({
      selection: {
        mode: 'filter',
        filter: { hasDebt: 'true' },
        excludeIds: [UUID],
      },
      from: '2026-11-01',
      to: '2026-12-01',
    });
    expect(dto.selection.excludeIds).toEqual([UUID]);
  });

  it.each([
    ['missing to', { from: '2026-03-01' }],
    ['to == from', { from: '2026-03-01', to: '2026-03-01' }],
    ['to < from', { from: '2026-03-02', to: '2026-03-01' }],
    ['> 366 days', { from: '2025-01-01', to: '2026-01-03' }],
    ['impossible day', { from: '2026-02-30', to: '2026-03-05' }],
    ['bad format', { from: '03-01-2026', to: '2026-03-05' }],
    ['missing from', { to: '2026-03-05' }],
    ['number', { from: 20260301, to: '2026-03-05' }],
  ])('rejects the period: %s', async (_label, period) => {
    await rejects({ selection: ids, ...period });
  });

  it.each([
    ['missing selection', { from: '2026-11-01', to: '2026-12-01' }],
    [
      'bad mode',
      { selection: { mode: 'all' }, from: '2026-11-01', to: '2026-12-01' },
    ],
    [
      'empty ids',
      {
        selection: { mode: 'ids', customerIds: [] },
        from: '2026-11-01',
        to: '2026-12-01',
      },
    ],
    [
      'unknown top-level key',
      { selection: ids, from: '2026-11-01', to: '2026-12-01', sortBy: 'name' },
    ],
  ])('rejects the body: %s', async (_label, body) => {
    await rejects(body);
  });
});
