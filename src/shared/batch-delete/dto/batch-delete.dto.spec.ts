/**
 * BatchDeleteDto — class-validator suite.
 *
 * Asserts R2: ids must be a non-empty UUID-4 array, max
 * BATCH_DELETE_MAX_SIZE (default 100), unique.
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { BatchDeleteDto } from './batch-delete.dto';
import { BATCH_DELETE_MAX_SIZE } from '../batch-delete.constants';

const validUuid = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

describe('BatchDeleteDto', () => {
  function makeDto(ids: string[]): BatchDeleteDto {
    const dto = new BatchDeleteDto();
    dto.ids = ids;
    return dto;
  }

  it('accepts a valid single-UUID batch', async () => {
    const errors = await validate(makeDto([validUuid('1')]));
    expect(errors).toHaveLength(0);
  });

  it('accepts a valid batch of N UUIDs at the size boundary', async () => {
    const ids = Array.from({ length: BATCH_DELETE_MAX_SIZE }, (_, i) =>
      validUuid(String(i + 1)),
    );
    const errors = await validate(makeDto(ids));
    expect(errors).toHaveLength(0);
  });

  it('rejects an empty array', async () => {
    const errors = await validate(makeDto([]));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'ids')).toBe(true);
  });

  it('rejects a batch over BATCH_DELETE_MAX_SIZE', async () => {
    const ids = Array.from({ length: BATCH_DELETE_MAX_SIZE + 1 }, (_, i) =>
      validUuid(String(i + 1)),
    );
    const errors = await validate(makeDto(ids));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'ids')).toBe(true);
  });

  it('rejects non-UUID values', async () => {
    const errors = await validate(makeDto(['not-a-uuid']));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects UUID v1 values (only v4 is accepted)', async () => {
    const v1 = '00000000-0000-1000-8000-000000000001';
    const errors = await validate(makeDto([v1]));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects duplicate IDs', async () => {
    const errors = await validate(makeDto([validUuid('1'), validUuid('1')]));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'ids')).toBe(true);
  });
});