import type { Type } from '@nestjs/common';
import { createAppValidationPipe } from '../../../shared/listing/app-validation.pipe';
import {
  ArchiveCustomerPetDto,
  CreateCustomerPetDto,
  DeleteCustomerPetQueryDto,
  ListCustomerPetsQueryDto,
  RestoreCustomerPetDto,
  UpdateCustomerPetDto,
} from './customer-pet.dto';

const pipe = createAppValidationPipe();
const run = (
  value: unknown,
  metatype: Type<unknown>,
  type: 'body' | 'query' = 'body',
) => pipe.transform(value, { type, metatype });

async function badFields(
  value: unknown,
  metatype: Type<unknown>,
  type: 'body' | 'query' = 'body',
): Promise<string[]> {
  try {
    await run(value, metatype, type);
  } catch (e) {
    const body = (
      e as { getResponse(): { message: { property: string }[] } }
    ).getResponse();
    expect((e as { getStatus(): number }).getStatus()).toBe(400);
    return body.message.map((m) => m.property);
  }
  throw new Error('expected 400');
}

describe('CreateCustomerPetDto', () => {
  it('accepts a minimal body and trims text', async () => {
    const dto = (await run(
      { name: '  Bruno ', species: 'DOG' },
      CreateCustomerPetDto,
    )) as CreateCustomerPetDto;
    expect(dto.name).toBe('Bruno');
    expect(dto.species).toBe('DOG');
  });

  it('accepts every optional field, with null as absent', async () => {
    await expect(
      run(
        {
          name: 'Max',
          species: 'OTHER',
          speciesOther: 'Conejo',
          breed: null,
          size: 'SMALL',
          birthDate: '2024-03-01',
          birthDatePrecision: 'MONTH',
          allergies: null,
          notes: 'x',
        },
        CreateCustomerPetDto,
      ),
    ).resolves.toBeDefined();
    await expect(
      run(
        { name: 'Max', species: 'DOG', approxAge: { years: 1, months: 4 } },
        CreateCustomerPetDto,
      ),
    ).resolves.toBeDefined();
  });

  it.each([
    ['missing name', { species: 'DOG' }, ['name']],
    ['blank name', { name: '   ', species: 'DOG' }, ['name']],
    ['name too long', { name: 'a'.repeat(61), species: 'DOG' }, ['name']],
    ['missing species', { name: 'Max' }, ['species']],
    ['bad species', { name: 'Max', species: 'BIRD' }, ['species']],
    ['bad size', { name: 'Max', species: 'DOG', size: 'TINY' }, ['size']],
    [
      'bad precision',
      { name: 'Max', species: 'DOG', birthDatePrecision: 'DAY' },
      ['birthDatePrecision'],
    ],
    [
      'speciesOther too long',
      { name: 'Max', species: 'OTHER', speciesOther: 'a'.repeat(41) },
      ['speciesOther'],
    ],
    [
      'breed too long',
      { name: 'Max', species: 'DOG', breed: 'a'.repeat(81) },
      ['breed'],
    ],
    [
      'allergies too long',
      { name: 'Max', species: 'DOG', allergies: 'a'.repeat(501) },
      ['allergies'],
    ],
    [
      'notes too long',
      { name: 'Max', species: 'DOG', notes: 'a'.repeat(501) },
      ['notes'],
    ],
    [
      'approxAge not an integer',
      { name: 'Max', species: 'DOG', approxAge: { months: 1.5 } },
      ['approxAge'],
    ],
    [
      'approxAge negative',
      { name: 'Max', species: 'DOG', approxAge: { years: -1 } },
      ['approxAge'],
    ],
    [
      'unknown property (status cannot be sent)',
      { name: 'Max', species: 'DOG', status: 'ARCHIVED' },
      ['status'],
    ],
    [
      'unknown property (version is not a create field)',
      { name: 'Max', species: 'DOG', version: 1 },
      ['version'],
    ],
  ])('%s → 400 naming the field', async (_n, body, fields) => {
    expect(await badFields(body, CreateCustomerPetDto)).toEqual(fields);
  });
});

describe('UpdateCustomerPetDto', () => {
  it('requires version', async () => {
    expect(await badFields({ breed: 'x' }, UpdateCustomerPetDto)).toEqual([
      'version',
    ]);
  });

  it.each([0, -1, 1.5, '3', null])('rejects version %p', async (version) => {
    expect(await badFields({ version }, UpdateCustomerPetDto)).toEqual([
      'version',
    ]);
  });

  it('keeps absent fields absent and null as null (clear)', async () => {
    const dto = (await run(
      { version: 2, allergies: null, breed: 'Poodle' },
      UpdateCustomerPetDto,
    )) as UpdateCustomerPetDto;
    expect(dto.version).toBe(2);
    expect(dto.allergies).toBeNull();
    expect(dto.breed).toBe('Poodle');
    expect(dto.notes).toBeUndefined();
    expect(dto.name).toBeUndefined();
    expect('size' in dto && dto.size !== undefined).toBe(false);
  });

  it.each([
    ['null name', { name: null }, ['name']],
    ['blank name', { name: ' ' }, ['name']],
    ['null species', { species: null }, ['species']],
    ['bad species', { species: 'BIRD' }, ['species']],
    ['unknown property', { status: 'ARCHIVED' }, ['status']],
  ])('%s → 400 naming the field', async (_n, extra, fields) => {
    expect(
      await badFields({ version: 1, ...extra }, UpdateCustomerPetDto),
    ).toEqual(fields);
  });
});

describe('ArchiveCustomerPetDto / RestoreCustomerPetDto', () => {
  it('archive: version required, reason optional ≤ 280', async () => {
    await expect(
      run({ version: 1 }, ArchiveCustomerPetDto),
    ).resolves.toBeDefined();
    await expect(
      run({ version: 1, reason: 'Ya no está' }, ArchiveCustomerPetDto),
    ).resolves.toBeDefined();
    expect(await badFields({}, ArchiveCustomerPetDto)).toEqual(['version']);
    expect(
      await badFields(
        { version: 1, reason: 'a'.repeat(281) },
        ArchiveCustomerPetDto,
      ),
    ).toEqual(['reason']);
  });

  it('restore: version required, nothing else', async () => {
    await expect(
      run({ version: 2 }, RestoreCustomerPetDto),
    ).resolves.toBeDefined();
    expect(await badFields({}, RestoreCustomerPetDto)).toEqual(['version']);
    expect(
      await badFields({ version: 2, reason: 'x' }, RestoreCustomerPetDto),
    ).toEqual(['reason']);
  });
});

describe('query DTOs', () => {
  it('delete: version is a positive integer taken from the query string', async () => {
    const dto = (await run(
      { version: '7' },
      DeleteCustomerPetQueryDto,
      'query',
    )) as DeleteCustomerPetQueryDto;
    expect(dto.version).toBe(7);
  });

  it.each([
    {},
    { version: 'abc' },
    { version: '1.5' },
    { version: '' },
    { version: '0' },
  ])('delete: %j → 400 on version', async (query) => {
    expect(await badFields(query, DeleteCustomerPetQueryDto, 'query')).toEqual([
      'version',
    ]);
  });

  it('list: status optional, ACTIVE|ARCHIVED|ALL', async () => {
    await expect(
      run({}, ListCustomerPetsQueryDto, 'query'),
    ).resolves.toBeDefined();
    for (const status of ['ACTIVE', 'ARCHIVED', 'ALL']) {
      await expect(
        run({ status }, ListCustomerPetsQueryDto, 'query'),
      ).resolves.toMatchObject({ status });
    }
    expect(
      await badFields({ status: 'DELETED' }, ListCustomerPetsQueryDto, 'query'),
    ).toEqual(['status']);
  });
});
