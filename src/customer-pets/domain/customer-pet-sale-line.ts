/**
 * Sale line ⇄ pet rules (contract `docs/proposals/customer-pets-contract.md`
 * v1 §4). Framework-free: the sales module reads the pet rows (FOR SHARE, in
 * its own transaction) and feeds them here, so the POS drafts and the bot
 * checkout apply exactly the same three validations.
 */
import { CustomerPetError } from './customer-pet-error';
import type { PetSpecies, PetStatus } from './customer-pet.types';

/** The columns of a pet row the line rules need. */
export interface SaleLinePetFacts {
  id: string;
  customerId: string;
  name: string;
  species: PetSpecies;
  status: PetStatus;
}

/** What a line stores when a pet is assigned (copied once, never refreshed). */
export interface SaleLinePetSnapshot {
  petId: string;
  petNameSnapshot: string;
  petSpeciesSnapshot: PetSpecies;
}

/** The persisted pet columns of a line (+ the joined current status). */
export interface SaleLinePetColumns {
  petId?: string | null;
  petNameSnapshot?: string | null;
  petSpeciesSnapshot?: PetSpecies | null;
  /** Current status through the join; null/absent when the pet row is gone. */
  petStatus?: PetStatus | null;
}

/** `pet` of every sale response line (contract §4.1). */
export interface SaleLinePetView {
  /** null only when the pet row disappeared (customer deleted) and the snapshot stayed. */
  id: string | null;
  name: string;
  species: PetSpecies;
  /** Current status; null when the pet row is gone but the snapshot remains. */
  status: PetStatus | null;
}

/**
 * Validates `pet` (the row found for `petId` in the sale's tenant, or
 * null/undefined) for assignment to a line of a sale of `saleCustomerId`:
 * a sale without customer → `PET_CUSTOMER_MISMATCH` (no lookup needed), unknown
 * → `PET_NOT_FOUND`, another customer's pet → `PET_CUSTOMER_MISMATCH` (checked
 * before the status, so an archived foreign pet reveals nothing), archived →
 * `PET_ARCHIVED`.
 */
export function resolveSaleLinePet(
  petId: string,
  saleCustomerId: string | null,
  pet: SaleLinePetFacts | null | undefined,
): SaleLinePetSnapshot {
  if (saleCustomerId === null) {
    throw new CustomerPetError('PET_CUSTOMER_MISMATCH');
  }
  if (!pet) throw new CustomerPetError('PET_NOT_FOUND');
  if (pet.customerId !== saleCustomerId) {
    throw new CustomerPetError('PET_CUSTOMER_MISMATCH');
  }
  if (pet.status !== 'ACTIVE') throw new CustomerPetError('PET_ARCHIVED');
  return {
    petId,
    petNameSnapshot: pet.name,
    petSpeciesSnapshot: pet.species,
  };
}

/**
 * The `pet` member of a sale line: null (never an object of nulls) without a
 * snapshot — old lines, lines without a pet and erased pets (§6).
 */
export function toSaleLinePetView(
  line: SaleLinePetColumns,
): SaleLinePetView | null {
  if (
    line.petNameSnapshot === null ||
    line.petNameSnapshot === undefined ||
    line.petSpeciesSnapshot === null ||
    line.petSpeciesSnapshot === undefined
  ) {
    return null;
  }
  return {
    id: line.petId ?? null,
    name: line.petNameSnapshot,
    species: line.petSpeciesSnapshot,
    status: line.petId ? (line.petStatus ?? null) : null,
  };
}
