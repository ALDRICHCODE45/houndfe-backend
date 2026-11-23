/**
 * Customer pets (contract `docs/proposals/customer-pets-contract.md` v1 §1-§3).
 * Framework-free types shared by the rules, the repository port and the service.
 */

export const PET_SPECIES = ['DOG', 'CAT', 'OTHER'] as const;
export type PetSpecies = (typeof PET_SPECIES)[number];

export const PET_SIZES = ['SMALL', 'MEDIUM', 'LARGE', 'GIANT'] as const;
export type PetSize = (typeof PET_SIZES)[number];

export const PET_BIRTH_DATE_PRECISIONS = ['EXACT', 'MONTH', 'YEAR'] as const;
export type PetBirthDatePrecision = (typeof PET_BIRTH_DATE_PRECISIONS)[number];

export const PET_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type PetStatus = (typeof PET_STATUSES)[number];

export const PET_CREATED_VIA = ['POS', 'CHATBOT'] as const;
export type PetCreatedVia = (typeof PET_CREATED_VIA)[number];

/** `?status=` of the list routes. */
export const PET_LIST_STATUSES = ['ACTIVE', 'ARCHIVED', 'ALL'] as const;
export type PetListStatus = (typeof PET_LIST_STATUSES)[number];

/** Owner decision Q2 (contract §1.1). */
export const MAX_ACTIVE_PETS_PER_CUSTOMER = 20;
/** `?status=ALL|ARCHIVED` stays unpaginated, capped (contract §1.1). */
export const MAX_LISTED_PETS = 100;

export const PET_LIMITS = {
  nameMax: 60,
  speciesOtherMax: 40,
  breedMax: 80,
  allergiesMax: 500,
  notesMax: 500,
  archivedReasonMax: 280,
  approxAgeYearsMax: 50,
  approxAgeMonthsMax: 600,
} as const;

export interface ApproxAge {
  years?: number;
  months?: number;
}

/** A pet as persisted. `birthDate` is the calendar date `YYYY-MM-DD`. */
export interface PetRecord {
  id: string;
  tenantId: string;
  customerId: string;
  name: string;
  nameKey: string;
  species: PetSpecies;
  speciesOther: string | null;
  breed: string | null;
  size: PetSize | null;
  birthDate: string | null;
  birthDatePrecision: PetBirthDatePrecision | null;
  allergies: string | null;
  notes: string | null;
  status: PetStatus;
  archivedAt: Date | null;
  archivedReason: string | null;
  createdVia: PetCreatedVia;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Validated, normalized values of a create. */
export interface PetWriteData {
  name: string;
  nameKey: string;
  species: PetSpecies;
  speciesOther: string | null;
  breed: string | null;
  size: PetSize | null;
  birthDate: string | null;
  birthDatePrecision: PetBirthDatePrecision | null;
  allergies: string | null;
  notes: string | null;
}

/** What a writer may send on create (`null` and absent are the same). */
export interface PetCreateInput {
  name: string;
  species: PetSpecies;
  speciesOther?: string | null;
  breed?: string | null;
  size?: PetSize | null;
  birthDate?: string | null;
  birthDatePrecision?: PetBirthDatePrecision | null;
  approxAge?: ApproxAge | null;
  allergies?: string | null;
  notes?: string | null;
}

/** PATCH: absent = unchanged, `null` clears a nullable field (contract §3). */
export interface PetPatchInput {
  name?: string | null;
  species?: PetSpecies | null;
  speciesOther?: string | null;
  breed?: string | null;
  size?: PetSize | null;
  birthDate?: string | null;
  birthDatePrecision?: PetBirthDatePrecision | null;
  approxAge?: ApproxAge | null;
  allergies?: string | null;
  notes?: string | null;
}

/** Column changes of one write; the repository adds `version + 1`. */
export type PetChange = Partial<PetWriteData> & {
  status?: PetStatus;
  archivedAt?: Date | null;
  archivedReason?: string | null;
};

/** The complete pet of contract §2 (every write also carries `warnings`). */
export interface PetView {
  id: string;
  customerId: string;
  name: string;
  species: PetSpecies;
  speciesOther: string | null;
  breed: string | null;
  size: PetSize | null;
  birthDate: string | null;
  birthDatePrecision: PetBirthDatePrecision | null;
  ageMonths: number | null;
  ageLabel: string | null;
  allergies: string | null;
  notes: string | null;
  status: PetStatus;
  archivedAt: string | null;
  archivedReason: string | null;
  createdVia: PetCreatedVia;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const PET_NAME_DUPLICATE = 'PET_NAME_DUPLICATE';
export type PetWarning = typeof PET_NAME_DUPLICATE;

export type PetWriteResult = PetView & { warnings: PetWarning[] };
