import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { businessToday } from '../../inventory/domain/fefo-allocator';
import {
  CustomerPetError,
  CustomerPetValidationError,
} from '../domain/customer-pet-error';
import {
  buildPetCreate,
  buildPetPatch,
  toPetView,
} from '../domain/customer-pet-rules';
import {
  CUSTOMER_PET_REPOSITORY,
  type ICustomerPetRepository,
  type PetWriteOutcome,
} from '../domain/customer-pet.repository';
import {
  PET_LIMITS,
  PET_NAME_DUPLICATE,
  type PetCreateInput,
  type PetCreatedVia,
  type PetListStatus,
  type PetPatchInput,
  type PetRecord,
  type PetView,
  type PetWarning,
  type PetWriteResult,
} from '../domain/customer-pet.types';

const DEFAULT_TIMEZONE = 'America/Mexico_City';

/**
 * Customer pets (contract v1 §1-§3, §6). Transport-free: the POS controller
 * (T1) and the bot controller (T2) both call it, so a bot caller passes
 * `createdVia = 'CHATBOT'` and maps the thrown errors with `toPetHttpError`.
 *
 * Throws `CustomerPetError` (404/409/422 codes) and `CustomerPetValidationError`
 * (400 per-field). Every returned pet carries the derived age, computed in the
 * business timezone (`PROMOTIONS_BUSINESS_TIMEZONE`, default
 * `America/Mexico_City` — the one the stock, promotions and backorder code use).
 */
@Injectable()
export class CustomerPetsService {
  constructor(
    @Inject(CUSTOMER_PET_REPOSITORY)
    private readonly pets: ICustomerPetRepository,
    private readonly config: ConfigService,
  ) {}

  /** `YYYY-MM-DD` of today in the business timezone. */
  private today(): string {
    return businessToday(
      new Date(),
      this.config.get<string>('PROMOTIONS_BUSINESS_TIMEZONE') ??
        DEFAULT_TIMEZONE,
    );
  }

  async list(
    customerId: string,
    status: PetListStatus = 'ACTIVE',
  ): Promise<PetView[]> {
    await this.requireCustomer(customerId);
    const today = this.today();
    const rows = await this.pets.list(customerId, status);
    return rows.map((row) => toPetView(row, today));
  }

  async create(
    customerId: string,
    input: PetCreateInput,
    createdVia: PetCreatedVia,
  ): Promise<PetWriteResult> {
    const today = this.today();
    const data = buildPetCreate(input, today);
    const outcome = await this.pets.create(
      customerId,
      crypto.randomUUID(),
      data,
      createdVia,
    );
    return this.written(outcome, customerId, '', today);
  }

  async update(
    customerId: string,
    petId: string,
    version: number,
    input: PetPatchInput,
  ): Promise<PetWriteResult> {
    const pet = await this.requirePet(customerId, petId);
    this.assertVersion(pet, version);
    if (pet.status === 'ARCHIVED') throw new CustomerPetError('PET_ARCHIVED');
    const today = this.today();
    const change = buildPetPatch(pet, input, today);
    const nameChanged = change.name !== undefined && change.name !== pet.name;
    const outcome = await this.pets.updateIfVersion(
      customerId,
      petId,
      version,
      change,
      { enforceLimit: false, checkDuplicate: nameChanged },
    );
    return this.written(outcome, customerId, petId, today);
  }

  async archive(
    customerId: string,
    petId: string,
    version: number,
    reason?: string | null,
  ): Promise<PetWriteResult> {
    const pet = await this.requirePet(customerId, petId);
    this.assertVersion(pet, version);
    if (pet.status === 'ARCHIVED') throw new CustomerPetError('PET_ARCHIVED');
    const archivedReason = this.cleanReason(reason);
    const outcome = await this.pets.updateIfVersion(
      customerId,
      petId,
      version,
      { status: 'ARCHIVED', archivedAt: new Date(), archivedReason },
      { enforceLimit: false, checkDuplicate: false },
    );
    return this.written(outcome, customerId, petId, this.today());
  }

  async restore(
    customerId: string,
    petId: string,
    version: number,
  ): Promise<PetWriteResult> {
    const pet = await this.requirePet(customerId, petId);
    this.assertVersion(pet, version);
    if (pet.status === 'ACTIVE') throw new CustomerPetError('PET_NOT_ARCHIVED');
    const outcome = await this.pets.updateIfVersion(
      customerId,
      petId,
      version,
      { status: 'ACTIVE', archivedAt: null, archivedReason: null },
      { enforceLimit: true, checkDuplicate: true },
    );
    return this.written(outcome, customerId, petId, this.today());
  }

  /**
   * Real erasure (contract §6, owner Q1): deletes the pet and clears the pet
   * columns of its sale lines in one transaction. An already deleted pet is
   * `PET_NOT_FOUND`.
   */
  async delete(
    customerId: string,
    petId: string,
    version: number,
  ): Promise<void> {
    const outcome = await this.pets.deleteIfVersion(customerId, petId, version);
    if (outcome.kind === 'deleted') return;
    if (outcome.kind === 'version_conflict') {
      throw new CustomerPetError('PET_VERSION_CONFLICT', {
        currentVersion: outcome.currentVersion,
      });
    }
    await this.requireCustomer(customerId);
    throw new CustomerPetError('PET_NOT_FOUND');
  }

  private async requireCustomer(customerId: string): Promise<void> {
    if (!(await this.pets.customerExists(customerId))) {
      throw new CustomerPetError('CUSTOMER_NOT_FOUND');
    }
  }

  private async requirePet(
    customerId: string,
    petId: string,
  ): Promise<PetRecord> {
    const pet = await this.pets.findById(customerId, petId);
    if (pet) return pet;
    await this.requireCustomer(customerId);
    throw new CustomerPetError('PET_NOT_FOUND');
  }

  private assertVersion(pet: PetRecord, version: number): void {
    if (pet.version !== version) {
      throw new CustomerPetError('PET_VERSION_CONFLICT', {
        currentVersion: pet.version,
      });
    }
  }

  private cleanReason(reason: string | null | undefined): string | null {
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (trimmed.length > PET_LIMITS.archivedReasonMax) {
      throw new CustomerPetValidationError([
        {
          field: 'reason',
          rule: 'maxLength',
          message: `reason must be shorter than or equal to ${PET_LIMITS.archivedReasonMax} characters`,
        },
      ]);
    }
    return trimmed === '' ? null : trimmed;
  }

  /** Turns a repository outcome into the contract's `pet + warnings` or the error. */
  private async written(
    outcome: PetWriteOutcome,
    customerId: string,
    petId: string,
    today: string,
  ): Promise<PetWriteResult> {
    switch (outcome.kind) {
      case 'ok': {
        const warnings: PetWarning[] = outcome.duplicateName
          ? [PET_NAME_DUPLICATE]
          : [];
        return { ...toPetView(outcome.pet, today), warnings };
      }
      case 'customer_not_found':
        throw new CustomerPetError('CUSTOMER_NOT_FOUND');
      case 'limit_reached':
        throw new CustomerPetError('PET_LIMIT_REACHED');
      case 'stale': {
        // Lost a race after the version check: report what is there now.
        const current = await this.pets.findById(customerId, petId);
        if (!current) throw new CustomerPetError('PET_NOT_FOUND');
        throw new CustomerPetError('PET_VERSION_CONFLICT', {
          currentVersion: current.version,
        });
      }
    }
  }
}
