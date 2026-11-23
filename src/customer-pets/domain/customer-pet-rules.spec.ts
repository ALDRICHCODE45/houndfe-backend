import { CustomerPetValidationError } from './customer-pet-error';
import {
  buildPetCreate,
  buildPetPatch,
  petNameKey,
  toPetView,
} from './customer-pet-rules';
import type { PetRecord } from './customer-pet.types';

const TODAY = '2026-11-23';

function record(over: Partial<PetRecord> = {}): PetRecord {
  return {
    id: 'pet-1',
    tenantId: 't-1',
    customerId: 'c-1',
    name: 'Bruno',
    nameKey: 'bruno',
    species: 'DOG',
    speciesOther: null,
    breed: 'Chihuahua',
    size: 'SMALL',
    birthDate: '2026-01-01',
    birthDatePrecision: 'MONTH',
    allergies: 'Pollo',
    notes: null,
    status: 'ACTIVE',
    archivedAt: null,
    archivedReason: null,
    createdVia: 'CHATBOT',
    version: 3,
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    updatedAt: new Date('2026-11-02T10:00:00.000Z'),
    ...over,
  };
}

function fieldsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CustomerPetValidationError);
    return (e as CustomerPetValidationError).fields.map((f) => f.field);
  }
  throw new Error('expected a validation error');
}

describe('petNameKey', () => {
  it.each([
    ['Bruno', 'bruno'],
    ['  Bruno  ', 'bruno'],
    ['MAX  el   Grande', 'max el grande'],
    ['Peña', 'pena'],
    ['Ñoño', 'nono'],
    ['Cañón Á É Í Ó Ú Ü', 'canon a e i o u u'],
    ['Luna\tdel\nSol', 'luna del sol'],
  ])('%j → %j', (name, key) => {
    expect(petNameKey(name)).toBe(key);
  });
});

describe('buildPetCreate', () => {
  it('trims, folds the key and defaults the optional fields to null', () => {
    expect(
      buildPetCreate({ name: '  Bruno  ', species: 'DOG' }, TODAY),
    ).toEqual({
      name: 'Bruno',
      nameKey: 'bruno',
      species: 'DOG',
      speciesOther: null,
      breed: null,
      size: null,
      birthDate: null,
      birthDatePrecision: null,
      allergies: null,
      notes: null,
    });
  });

  it('keeps an EXACT date as sent', () => {
    const data = buildPetCreate(
      {
        name: 'Max',
        species: 'DOG',
        birthDate: '2024-03-15',
        birthDatePrecision: 'EXACT',
      },
      TODAY,
    );
    expect(data.birthDate).toBe('2024-03-15');
    expect(data.birthDatePrecision).toBe('EXACT');
  });

  it('forces day 01 for MONTH and January 1 for YEAR', () => {
    const month = buildPetCreate(
      {
        name: 'Max',
        species: 'DOG',
        birthDate: '2024-03-15',
        birthDatePrecision: 'MONTH',
      },
      TODAY,
    );
    expect(month.birthDate).toBe('2024-03-01');
    const year = buildPetCreate(
      {
        name: 'Max',
        species: 'DOG',
        birthDate: '2024-06-15',
        birthDatePrecision: 'YEAR',
      },
      TODAY,
    );
    expect(year.birthDate).toBe('2024-01-01');
  });

  it('converts approxAge with the contract table', () => {
    const data = buildPetCreate(
      { name: 'Bruno', species: 'DOG', approxAge: { months: 10 } },
      TODAY,
    );
    expect(data.birthDate).toBe('2026-01-01');
    expect(data.birthDatePrecision).toBe('MONTH');
  });

  it('accepts today as an EXACT birth date and a MONTH date later in the current month', () => {
    expect(
      buildPetCreate(
        {
          name: 'Max',
          species: 'DOG',
          birthDate: TODAY,
          birthDatePrecision: 'EXACT',
        },
        TODAY,
      ).birthDate,
    ).toBe(TODAY);
    expect(
      buildPetCreate(
        {
          name: 'Max',
          species: 'DOG',
          birthDate: '2026-11-30',
          birthDatePrecision: 'MONTH',
        },
        TODAY,
      ).birthDate,
    ).toBe('2026-11-01');
  });

  it('turns empty optional text into null', () => {
    const data = buildPetCreate(
      {
        name: 'Max',
        species: 'DOG',
        breed: '   ',
        allergies: '',
        notes: ' hola ',
      },
      TODAY,
    );
    expect(data.breed).toBeNull();
    expect(data.allergies).toBeNull();
    expect(data.notes).toBe('hola');
  });

  describe('rejections (400 with a field error)', () => {
    const base = { name: 'Max', species: 'DOG' as const };

    it.each([
      ['empty name', { ...base, name: '   ' }, ['name']],
      ['name > 60', { ...base, name: 'a'.repeat(61) }, ['name']],
      ['breed > 80', { ...base, breed: 'a'.repeat(81) }, ['breed']],
      [
        'allergies > 500',
        { ...base, allergies: 'a'.repeat(501) },
        ['allergies'],
      ],
      ['notes > 500', { ...base, notes: 'a'.repeat(501) }, ['notes']],
      [
        'OTHER without speciesOther',
        { ...base, species: 'OTHER' as const },
        ['speciesOther'],
      ],
      [
        'OTHER with blank speciesOther',
        { ...base, species: 'OTHER' as const, speciesOther: '  ' },
        ['speciesOther'],
      ],
      [
        'speciesOther > 40',
        { ...base, species: 'OTHER' as const, speciesOther: 'a'.repeat(41) },
        ['speciesOther'],
      ],
      [
        'speciesOther on DOG',
        { ...base, speciesOther: 'Conejo' },
        ['speciesOther'],
      ],
      [
        'birthDate without precision',
        { ...base, birthDate: '2024-03-15' },
        ['birthDatePrecision'],
      ],
      [
        'precision without birthDate',
        { ...base, birthDatePrecision: 'EXACT' as const },
        ['birthDatePrecision'],
      ],
      [
        'impossible calendar date',
        {
          ...base,
          birthDate: '2023-02-29',
          birthDatePrecision: 'EXACT' as const,
        },
        ['birthDate'],
      ],
      [
        'future date',
        {
          ...base,
          birthDate: '2026-11-24',
          birthDatePrecision: 'EXACT' as const,
        },
        ['birthDate'],
      ],
      [
        'future month',
        {
          ...base,
          birthDate: '2026-12-01',
          birthDatePrecision: 'MONTH' as const,
        },
        ['birthDate'],
      ],
      [
        'approxAge with birthDate',
        {
          ...base,
          birthDate: '2024-03-15',
          birthDatePrecision: 'EXACT' as const,
          approxAge: { months: 3 },
        },
        ['approxAge'],
      ],
      [
        'approxAge with birthDate null',
        { ...base, birthDate: null, approxAge: { months: 3 } },
        ['approxAge'],
      ],
      ['empty approxAge', { ...base, approxAge: {} }, ['approxAge']],
      [
        'approxAge years above the cap',
        { ...base, approxAge: { years: 51 } },
        ['approxAge'],
      ],
    ])('%s', (_name, input, fields) => {
      expect(fieldsOf(() => buildPetCreate(input, TODAY))).toEqual(fields);
    });

    it('reports every offending field, not only the first', () => {
      expect(
        fieldsOf(() =>
          buildPetCreate(
            { name: '', species: 'OTHER', breed: 'a'.repeat(81) },
            TODAY,
          ),
        ).sort(),
      ).toEqual(['breed', 'name', 'speciesOther']);
    });
  });
});

describe('buildPetPatch', () => {
  it('an absent field is unchanged: an empty patch changes nothing', () => {
    expect(buildPetPatch(record(), {}, TODAY)).toEqual({});
  });

  it('changes only what was sent', () => {
    expect(buildPetPatch(record(), { breed: 'Poodle' }, TODAY)).toEqual({
      breed: 'Poodle',
    });
  });

  it('null clears each nullable field', () => {
    expect(
      buildPetPatch(
        record({ notes: 'x' }),
        { breed: null, size: null, allergies: null, notes: null },
        TODAY,
      ),
    ).toEqual({ breed: null, size: null, allergies: null, notes: null });
  });

  it('birthDate null clears the date and its precision together', () => {
    expect(buildPetPatch(record(), { birthDate: null }, TODAY)).toEqual({
      birthDate: null,
      birthDatePrecision: null,
    });
    expect(
      buildPetPatch(
        record(),
        { birthDate: null, birthDatePrecision: null },
        TODAY,
      ),
    ).toEqual({ birthDate: null, birthDatePrecision: null });
  });

  it('name sent recomputes the key', () => {
    expect(buildPetPatch(record(), { name: ' Peña ' }, TODAY)).toEqual({
      name: 'Peña',
      nameKey: 'pena',
    });
  });

  it('approxAge replaces the birth date', () => {
    expect(buildPetPatch(record(), { approxAge: { years: 3 } }, TODAY)).toEqual(
      { birthDate: '2023-01-01', birthDatePrecision: 'YEAR' },
    );
  });

  it('switching to a non-OTHER species clears a stored speciesOther', () => {
    expect(
      buildPetPatch(
        record({ species: 'OTHER', speciesOther: 'Conejo' }),
        { species: 'CAT' },
        TODAY,
      ),
    ).toEqual({ species: 'CAT', speciesOther: null });
  });

  it('switching to OTHER needs a speciesOther', () => {
    expect(
      fieldsOf(() => buildPetPatch(record(), { species: 'OTHER' }, TODAY)),
    ).toEqual(['speciesOther']);
    expect(
      buildPetPatch(
        record(),
        { species: 'OTHER', speciesOther: 'Conejo' },
        TODAY,
      ),
    ).toEqual({ species: 'OTHER', speciesOther: 'Conejo' });
  });

  it.each([
    ['null name', { name: null }, ['name']],
    ['empty name', { name: ' ' }, ['name']],
    ['null species', { species: null }, ['species']],
    [
      'speciesOther null on an OTHER pet',
      { speciesOther: null },
      ['speciesOther'],
    ],
    [
      'precision without a date change on a pet without date',
      { birthDatePrecision: 'YEAR' },
      ['birthDatePrecision'],
    ],
    [
      'birthDate without precision',
      { birthDate: '2024-03-15' },
      ['birthDatePrecision'],
    ],
    [
      'precision with a null date',
      { birthDate: null, birthDatePrecision: 'EXACT' },
      ['birthDatePrecision'],
    ],
    [
      'approxAge with birthDate',
      {
        birthDate: '2024-03-15',
        birthDatePrecision: 'EXACT',
        approxAge: { months: 1 },
      },
      ['approxAge'],
    ],
    [
      'future birthDate',
      { birthDate: '2027-01-01', birthDatePrecision: 'EXACT' },
      ['birthDate'],
    ],
  ])('%s → 400 field error', (name, input, fields) => {
    const current =
      name === 'speciesOther null on an OTHER pet'
        ? record({ species: 'OTHER', speciesOther: 'Conejo' })
        : name.startsWith('precision without a date')
          ? record({ birthDate: null, birthDatePrecision: null })
          : record();
    expect(
      fieldsOf(() => buildPetPatch(current, input as never, TODAY)),
    ).toEqual(fields);
  });
});

describe('toPetView (contract §2)', () => {
  it('has exactly the contract fields with derived age', () => {
    expect(toPetView(record(), TODAY)).toEqual({
      id: 'pet-1',
      customerId: 'c-1',
      name: 'Bruno',
      species: 'DOG',
      speciesOther: null,
      breed: 'Chihuahua',
      size: 'SMALL',
      birthDate: '2026-01-01',
      birthDatePrecision: 'MONTH',
      ageMonths: 10,
      ageLabel: '~10 meses',
      allergies: 'Pollo',
      notes: null,
      status: 'ACTIVE',
      archivedAt: null,
      archivedReason: null,
      createdVia: 'CHATBOT',
      version: 3,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-02T10:00:00.000Z',
    });
  });

  it('never exposes tenantId or nameKey and nulls the age without a birth date', () => {
    const view = toPetView(
      record({ birthDate: null, birthDatePrecision: null }),
      TODAY,
    );
    expect(view).not.toHaveProperty('tenantId');
    expect(view).not.toHaveProperty('nameKey');
    expect(view.ageMonths).toBeNull();
    expect(view.ageLabel).toBeNull();
  });

  it('serialises archivedAt', () => {
    expect(
      toPetView(
        record({
          status: 'ARCHIVED',
          archivedAt: new Date('2026-11-10T00:00:00.000Z'),
          archivedReason: 'Ya no está',
        }),
        TODAY,
      ),
    ).toMatchObject({
      status: 'ARCHIVED',
      archivedAt: '2026-11-10T00:00:00.000Z',
      archivedReason: 'Ya no está',
    });
  });
});
