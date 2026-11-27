import 'reflect-metadata';
import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { CustomersBulkExportBodyDto } from './customers-bulk-export.dto';

const ID_A = '3f2a9c1e-0000-4000-8000-000000000001';
const ID_B = '3f2a9c1e-0000-4000-8000-000000000002';
const uuid = (n: number) =>
  `3f2a9c1e-0000-4000-8000-${n.toString().padStart(12, '0')}`;

/** Runs the production global pipe exactly as Nest does for a @Body(). */
async function pipe(body: unknown) {
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: CustomersBulkExportBodyDto,
  };
  return createAppValidationPipe().transform(
    body,
    metadata,
  ) as Promise<CustomersBulkExportBodyDto>;
}

async function rejection(body: unknown): Promise<Record<string, unknown>> {
  try {
    await pipe(body);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  }
  throw new Error('expected a 400');
}

/** Flattens nested ValidationError trees into `path` strings. */
function paths(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (errors: unknown, prefix: string) => {
    for (const error of errors as Array<{
      property: string;
      children?: unknown[];
      constraints?: Record<string, string>;
    }>) {
      const path = prefix ? `${prefix}.${error.property}` : error.property;
      if (error.constraints) out.push(path);
      if (error.children?.length) walk(error.children, path);
    }
  };
  walk(body.message, '');
  return out;
}

describe('CustomersBulkExportBodyDto / selection (contract §2.1, §2.2, §4.1)', () => {
  it('accepts ids mode', async () => {
    const dto = await pipe({
      selection: { mode: 'ids', customerIds: [ID_A, ID_B] },
    });
    expect(dto.selection.mode).toBe('ids');
    expect(dto.selection.customerIds).toEqual([ID_A, ID_B]);
    expect(dto.sortBy).toBeUndefined();
  });

  it('accepts filter mode with excludeIds and keeps the filter object untouched', async () => {
    const dto = await pipe({
      selection: {
        mode: 'filter',
        filter: { hasDebt: 'true', city: 'Zapopan,León', page: '2' },
        excludeIds: [ID_A],
      },
      sortBy: 'openDebt',
      sortOrder: 'asc',
    });
    // The filter is validated later with the listing DTO (resolver), so the
    // global pipe must not strip or coerce its keys.
    expect(dto.selection.filter).toEqual({
      hasDebt: 'true',
      city: 'Zapopan,León',
      page: '2',
    });
    expect(dto.selection.excludeIds).toEqual([ID_A]);
    expect(dto.sortBy).toBe('openDebt');
    expect(dto.sortOrder).toBe('asc');
  });

  it('accepts filter mode with an empty filter and no excludeIds', async () => {
    const dto = await pipe({ selection: { mode: 'filter', filter: {} } });
    expect(dto.selection.filter).toEqual({});
    expect(dto.selection.excludeIds).toBeUndefined();
  });

  it('accepts exactly 1,000 ids and 1,000 excludeIds', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => uuid(i + 1));
    await expect(
      pipe({ selection: { mode: 'ids', customerIds: many } }),
    ).resolves.toBeDefined();
    await expect(
      pipe({ selection: { mode: 'filter', filter: {}, excludeIds: many } }),
    ).resolves.toBeDefined();
  });

  it.each<[string, unknown, string]>([
    ['selection missing', {}, 'selection'],
    ['selection not an object', { selection: 'ids' }, 'selection'],
    ['mode missing', { selection: { customerIds: [ID_A] } }, 'selection.mode'],
    [
      'mode unknown',
      { selection: { mode: 'all', customerIds: [ID_A] } },
      'selection.mode',
    ],
    [
      'customerIds missing in ids mode',
      { selection: { mode: 'ids' } },
      'selection.customerIds',
    ],
    [
      'customerIds empty',
      { selection: { mode: 'ids', customerIds: [] } },
      'selection.customerIds',
    ],
    [
      'customerIds not UUIDs',
      { selection: { mode: 'ids', customerIds: ['abc'] } },
      'selection.customerIds',
    ],
    [
      'customerIds over 1,000',
      {
        selection: {
          mode: 'ids',
          customerIds: Array.from({ length: 1001 }, (_, i) => uuid(i + 1)),
        },
      },
      'selection.customerIds',
    ],
    [
      'filter key in ids mode',
      { selection: { mode: 'ids', customerIds: [ID_A], filter: {} } },
      'selection.filter',
    ],
    [
      'excludeIds in ids mode',
      { selection: { mode: 'ids', customerIds: [ID_A], excludeIds: [ID_B] } },
      'selection.excludeIds',
    ],
    [
      'customerIds in filter mode',
      { selection: { mode: 'filter', filter: {}, customerIds: [ID_A] } },
      'selection.customerIds',
    ],
    [
      'filter missing in filter mode',
      { selection: { mode: 'filter' } },
      'selection.filter',
    ],
    [
      'filter not an object',
      { selection: { mode: 'filter', filter: 'hasDebt=true' } },
      'selection.filter',
    ],
    [
      'filter is an array',
      { selection: { mode: 'filter', filter: [] } },
      'selection.filter',
    ],
    [
      'excludeIds not UUIDs',
      { selection: { mode: 'filter', filter: {}, excludeIds: ['x'] } },
      'selection.excludeIds',
    ],
    [
      'excludeIds over 1,000',
      {
        selection: {
          mode: 'filter',
          filter: {},
          excludeIds: Array.from({ length: 1001 }, (_, i) => uuid(i + 1)),
        },
      },
      'selection.excludeIds',
    ],
    [
      'unknown selection key',
      { selection: { mode: 'ids', customerIds: [ID_A], all: true } },
      'selection.all',
    ],
    [
      'unknown body key',
      { selection: { mode: 'ids', customerIds: [ID_A] }, format: 'xlsx' },
      'format',
    ],
    [
      'bad sortBy',
      { selection: { mode: 'ids', customerIds: [ID_A] }, sortBy: 'debt' },
      'sortBy',
    ],
    [
      'bad sortOrder',
      { selection: { mode: 'ids', customerIds: [ID_A] }, sortOrder: 'up' },
      'sortOrder',
    ],
  ])('%s → standard 400 on %s', async (_label, body, path) => {
    const response = await rejection(body);
    expect(response.statusCode).toBe(400);
    expect(response.code).toBeUndefined();
    expect(paths(response)).toContain(path);
  });
});
