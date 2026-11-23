import {
  approxAgeToBirth,
  derivePetAge,
  isRealIsoDate,
} from './customer-pet-age';
import {
  CustomerPetValidationError,
  type PetFieldError,
} from './customer-pet-error';
import {
  PET_BIRTH_DATE_PRECISIONS,
  PET_LIMITS,
  PET_SIZES,
  PET_SPECIES,
  type ApproxAge,
  type PetBirthDatePrecision,
  type PetChange,
  type PetCreateInput,
  type PetPatchInput,
  type PetRecord,
  type PetView,
  type PetWriteData,
} from './customer-pet.types';

/**
 * `name` folded for POS search and the duplicate warning (contract §1): the
 * same fold as `foldText` in `chatbot-requests/domain/inbox-search.ts` (NFD,
 * marks stripped, lower case) plus trim and collapsed whitespace. Kept as a
 * local copy so this module does not depend on the chatbot inbox.
 */
export function petNameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collects field errors; `throwIfAny` raises them as one 400. */
class Problems {
  private readonly list: PetFieldError[] = [];

  add(field: string, rule: string, message: string): void {
    this.list.push({ field, rule, message });
  }

  has(field: string): boolean {
    return this.list.some((p) => p.field === field);
  }

  throwIfAny(): void {
    if (this.list.length > 0) throw new CustomerPetValidationError(this.list);
  }
}

/**
 * Optional free text: `undefined` stays `undefined` (unchanged), `null` and
 * blank become `null`, otherwise the trimmed value within `max`.
 */
function optionalText(
  problems: Problems,
  field: string,
  value: unknown,
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    problems.add(field, 'isString', `${field} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    problems.add(
      field,
      'maxLength',
      `${field} must be shorter than or equal to ${max} characters`,
    );
    return undefined;
  }
  return trimmed === '' ? null : trimmed;
}

function requiredName(problems: Problems, value: unknown): string | undefined {
  if (typeof value !== 'string') {
    problems.add('name', 'isString', 'name must be a string');
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    problems.add('name', 'isNotEmpty', 'name should not be empty');
    return undefined;
  }
  if (trimmed.length > PET_LIMITS.nameMax) {
    problems.add(
      'name',
      'maxLength',
      `name must be shorter than or equal to ${PET_LIMITS.nameMax} characters`,
    );
    return undefined;
  }
  return trimmed;
}

function enumValue<T extends string>(
  problems: Problems,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    problems.add(
      field,
      'isIn',
      `${field} must be one of the following values: ${allowed.join(', ')}`,
    );
    return undefined;
  }
  return value as T;
}

function checkApproxAge(
  problems: Problems,
  approx: ApproxAge,
): approx is ApproxAge {
  const intIn = (v: unknown, max: number) =>
    v === undefined ||
    (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max);
  const ok =
    typeof approx === 'object' &&
    (approx.years !== undefined || approx.months !== undefined) &&
    intIn(approx.years, PET_LIMITS.approxAgeYearsMax) &&
    intIn(approx.months, PET_LIMITS.approxAgeMonthsMax);
  if (!ok) {
    problems.add(
      'approxAge',
      'approxAgeInvalid',
      `approxAge needs years (0-${PET_LIMITS.approxAgeYearsMax}) and/or months (0-${PET_LIMITS.approxAgeMonthsMax}), whole numbers`,
    );
  }
  return ok;
}

interface BirthInput {
  birthDate?: string | null;
  birthDatePrecision?: PetBirthDatePrecision | null;
  approxAge?: ApproxAge | null;
}

/**
 * The birth date a write ends up with. `undefined` = the writer did not touch
 * it; `{ birthDate: null, … }` clears it. Cross-field rules of contract §1.2/§8:
 * `approxAge` and `birthDate` are exclusive, the precision travels with the
 * date, MONTH forces day 01 (YEAR forces January 1), never in the future.
 */
function resolveBirth(
  problems: Problems,
  input: BirthInput,
  today: string,
):
  | {
      birthDate: string | null;
      birthDatePrecision: PetBirthDatePrecision | null;
    }
  | undefined {
  const approx = input.approxAge ?? undefined;
  const hasDate = input.birthDate !== undefined;
  const precision = input.birthDatePrecision;

  if (approx !== undefined) {
    if (hasDate || precision !== undefined) {
      problems.add(
        'approxAge',
        'approxAgeConflict',
        'approxAge cannot be sent together with birthDate or birthDatePrecision',
      );
      return undefined;
    }
    return checkApproxAge(problems, approx)
      ? approxAgeToBirth(approx, today)
      : undefined;
  }

  const precisionWithoutDate = () =>
    problems.add(
      'birthDatePrecision',
      'birthDatePrecisionWithoutDate',
      'birthDatePrecision requires a birthDate',
    );

  if (!hasDate) {
    // A lone `null` precision says nothing; a lone value has no date to describe.
    if (precision !== undefined && precision !== null) precisionWithoutDate();
    return undefined;
  }

  if (input.birthDate === null) {
    if (precision !== undefined && precision !== null) {
      precisionWithoutDate();
      return undefined;
    }
    return { birthDate: null, birthDatePrecision: null };
  }

  const date: unknown = input.birthDate;
  if (typeof date !== 'string' || !isRealIsoDate(date)) {
    problems.add(
      'birthDate',
      'birthDateInvalid',
      'birthDate must be a valid YYYY-MM-DD date',
    );
    return undefined;
  }
  if (precision === undefined || precision === null) {
    problems.add(
      'birthDatePrecision',
      'birthDatePrecisionRequired',
      'birthDatePrecision is required when birthDate is set',
    );
    return undefined;
  }
  const parsed = enumValue(
    problems,
    'birthDatePrecision',
    precision,
    PET_BIRTH_DATE_PRECISIONS,
  );
  if (!parsed) return undefined;
  const normalized =
    parsed === 'MONTH'
      ? `${date.slice(0, 7)}-01`
      : parsed === 'YEAR'
        ? `${date.slice(0, 4)}-01-01`
        : date;
  if (normalized > today) {
    problems.add(
      'birthDate',
      'birthDateInFuture',
      'birthDate must not be in the future',
    );
    return undefined;
  }
  return { birthDate: normalized, birthDatePrecision: parsed };
}

/** Validates and normalizes a create. Throws `CustomerPetValidationError` (400). */
export function buildPetCreate(
  input: PetCreateInput,
  today: string,
): PetWriteData {
  const problems = new Problems();
  const name = requiredName(problems, input.name);
  const species = enumValue(problems, 'species', input.species, PET_SPECIES);
  if (input.species === undefined || input.species === null) {
    problems.add('species', 'isNotEmpty', 'species should not be empty');
  }
  const speciesOther = optionalText(
    problems,
    'speciesOther',
    input.speciesOther,
    PET_LIMITS.speciesOtherMax,
  );
  if (species === 'OTHER' && !speciesOther && !problems.has('speciesOther')) {
    problems.add(
      'speciesOther',
      'speciesOtherRequired',
      'speciesOther is required when species is OTHER',
    );
  } else if (species && species !== 'OTHER' && speciesOther) {
    problems.add(
      'speciesOther',
      'speciesOtherNotAllowed',
      'speciesOther must be empty unless species is OTHER',
    );
  }
  const breed = optionalText(
    problems,
    'breed',
    input.breed,
    PET_LIMITS.breedMax,
  );
  const size = enumValue(problems, 'size', input.size, PET_SIZES);
  const allergies = optionalText(
    problems,
    'allergies',
    input.allergies,
    PET_LIMITS.allergiesMax,
  );
  const notes = optionalText(
    problems,
    'notes',
    input.notes,
    PET_LIMITS.notesMax,
  );
  const birth = resolveBirth(problems, input, today);
  problems.throwIfAny();

  return {
    name: name as string,
    nameKey: petNameKey(name as string),
    species: species as PetWriteData['species'],
    speciesOther: species === 'OTHER' ? (speciesOther ?? null) : null,
    breed: breed ?? null,
    size: size ?? null,
    birthDate: birth?.birthDate ?? null,
    birthDatePrecision: birth?.birthDatePrecision ?? null,
    allergies: allergies ?? null,
    notes: notes ?? null,
  };
}

/**
 * Validates a PATCH against the current pet and returns only the columns that
 * change (contract §3): absent = unchanged, `null` clears a nullable field,
 * `null` on `name` or `species` is a 400.
 */
export function buildPetPatch(
  current: PetRecord,
  input: PetPatchInput,
  today: string,
): PetChange {
  const problems = new Problems();
  const change: PetChange = {};

  if (input.name !== undefined) {
    const name = requiredName(problems, input.name);
    if (name !== undefined) {
      change.name = name;
      change.nameKey = petNameKey(name);
    }
  }

  let species = current.species;
  if (input.species !== undefined) {
    if (input.species === null) {
      problems.add('species', 'isNotEmpty', 'species should not be empty');
    } else {
      const parsed = enumValue(problems, 'species', input.species, PET_SPECIES);
      if (parsed) {
        species = parsed;
        change.species = parsed;
      }
    }
  }

  const speciesOtherSent = input.speciesOther !== undefined;
  const sentOther = optionalText(
    problems,
    'speciesOther',
    input.speciesOther,
    PET_LIMITS.speciesOtherMax,
  );
  if (species === 'OTHER') {
    const other = speciesOtherSent ? sentOther : current.speciesOther;
    if (!other) {
      if (!problems.has('speciesOther'))
        problems.add(
          'speciesOther',
          'speciesOtherRequired',
          'speciesOther is required when species is OTHER',
        );
    } else if (speciesOtherSent || change.species !== undefined) {
      change.speciesOther = other;
    }
  } else {
    if (speciesOtherSent && sentOther) {
      problems.add(
        'speciesOther',
        'speciesOtherNotAllowed',
        'speciesOther must be empty unless species is OTHER',
      );
    } else if (change.species !== undefined || speciesOtherSent) {
      change.speciesOther = null;
    }
  }

  const breed = optionalText(
    problems,
    'breed',
    input.breed,
    PET_LIMITS.breedMax,
  );
  if (breed !== undefined) change.breed = breed;
  if (input.size !== undefined) {
    if (input.size === null) change.size = null;
    else {
      const size = enumValue(problems, 'size', input.size, PET_SIZES);
      if (size) change.size = size;
    }
  }
  const allergies = optionalText(
    problems,
    'allergies',
    input.allergies,
    PET_LIMITS.allergiesMax,
  );
  if (allergies !== undefined) change.allergies = allergies;
  const notes = optionalText(
    problems,
    'notes',
    input.notes,
    PET_LIMITS.notesMax,
  );
  if (notes !== undefined) change.notes = notes;

  const birth = resolveBirth(problems, input, today);
  if (birth) {
    change.birthDate = birth.birthDate;
    change.birthDatePrecision = birth.birthDatePrecision;
  }

  problems.throwIfAny();
  return change;
}

/** The complete pet of contract §2 with the derived age (tenant-timezone `today`). */
export function toPetView(record: PetRecord, today: string): PetView {
  const { ageMonths, ageLabel } = derivePetAge(
    record.birthDate,
    record.birthDatePrecision,
    today,
  );
  return {
    id: record.id,
    customerId: record.customerId,
    name: record.name,
    species: record.species,
    speciesOther: record.speciesOther,
    breed: record.breed,
    size: record.size,
    birthDate: record.birthDate,
    birthDatePrecision: record.birthDatePrecision,
    ageMonths,
    ageLabel,
    allergies: record.allergies,
    notes: record.notes,
    status: record.status,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    archivedReason: record.archivedReason,
    createdVia: record.createdVia,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
