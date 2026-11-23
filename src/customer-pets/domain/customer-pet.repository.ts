import type {
  PetChange,
  PetCreatedVia,
  PetListStatus,
  PetRecord,
  PetWriteData,
} from './customer-pet.types';

/** Result of a write that may race or break a rule only the database can judge. */
export type PetWriteOutcome =
  | {
      kind: 'ok';
      pet: PetRecord;
      /** Another ACTIVE pet of the customer has the same `nameKey` (D8). */
      duplicateName: boolean;
    }
  | { kind: 'customer_not_found' }
  /** The customer already has the maximum of ACTIVE pets (contract §1.1). */
  | { kind: 'limit_reached' }
  /** The pet is gone or its `version` is no longer the expected one. */
  | { kind: 'stale' };

export type PetDeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'not_found' }
  | { kind: 'version_conflict'; currentVersion: number };

/** Port of the pet store. Always scoped to the request's tenant. */
export interface ICustomerPetRepository {
  customerExists(customerId: string): Promise<boolean>;
  list(customerId: string, status: PetListStatus): Promise<PetRecord[]>;
  /** The pet only when it belongs to `customerId` (and the tenant). */
  findById(customerId: string, petId: string): Promise<PetRecord | null>;
  /**
   * One transaction: lock the customer row (`FOR UPDATE`), refuse past the
   * ACTIVE limit, insert the pet with `version = 1`.
   */
  create(
    customerId: string,
    id: string,
    data: PetWriteData,
    createdVia: PetCreatedVia,
  ): Promise<PetWriteOutcome>;
  /**
   * One transaction: applies `change` and `version + 1` only when the pet still
   * has `expectedVersion` (`stale` otherwise). `enforceLimit` first locks the
   * customer and refuses when it already has the maximum of ACTIVE pets;
   * `checkDuplicate` reports another ACTIVE pet with the same `nameKey`.
   */
  updateIfVersion(
    customerId: string,
    petId: string,
    expectedVersion: number,
    change: PetChange,
    options: { enforceLimit: boolean; checkDuplicate: boolean },
  ): Promise<PetWriteOutcome>;
  /**
   * One transaction: clears `petId`, `petNameSnapshot` and `petSpeciesSnapshot`
   * on every sale line of the pet and deletes the pet (contract §6).
   */
  deleteIfVersion(
    customerId: string,
    petId: string,
    expectedVersion: number,
  ): Promise<PetDeleteOutcome>;
}

export const CUSTOMER_PET_REPOSITORY = Symbol('CUSTOMER_PET_REPOSITORY');
