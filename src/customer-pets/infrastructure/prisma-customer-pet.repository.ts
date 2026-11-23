import { Injectable } from '@nestjs/common';
import { Prisma, type CustomerPet } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  ICustomerPetRepository,
  PetDeleteOutcome,
  PetWriteOutcome,
} from '../domain/customer-pet.repository';
import {
  MAX_ACTIVE_PETS_PER_CUSTOMER,
  MAX_LISTED_PETS,
  type PetChange,
  type PetCreatedVia,
  type PetListStatus,
  type PetRecord,
  type PetWriteData,
} from '../domain/customer-pet.types';

/** `YYYY-MM-DD` ⇄ the `DATE` column (stored as UTC midnight). */
const toDate = (value: string | null): Date | null =>
  value === null ? null : new Date(`${value}T00:00:00.000Z`);

@Injectable()
export class PrismaCustomerPetRepository implements ICustomerPetRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async customerExists(customerId: string): Promise<boolean> {
    const row = await this.tenantPrisma.getClient().customer.findFirst({
      where: { id: customerId },
      select: { id: true },
    });
    return row !== null;
  }

  async list(customerId: string, status: PetListStatus): Promise<PetRecord[]> {
    const tenantId = this.tenantPrisma.getTenantId();
    const prisma = this.tenantPrisma.getClient();
    const where: Prisma.CustomerPetWhereInput = {
      customerId,
      tenantId,
      ...(status === 'ALL' ? {} : { status }),
    };
    const rows = await prisma.customerPet.findMany({
      where,
      // ACTIVE by name, ARCHIVED by archivedAt desc, ALL newest first; the
      // unpaginated lists are capped (contract §1.1, §5).
      orderBy:
        status === 'ACTIVE'
          ? [{ nameKey: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
          : status === 'ARCHIVED'
            ? [{ archivedAt: 'desc' }, { id: 'asc' }]
            : [{ createdAt: 'desc' }, { id: 'asc' }],
      ...(status === 'ACTIVE' ? {} : { take: MAX_LISTED_PETS }),
    });
    return rows.map((row) => this.toRecord(row));
  }

  async findById(customerId: string, petId: string): Promise<PetRecord | null> {
    const tenantId = this.tenantPrisma.getTenantId();
    const row = await this.tenantPrisma.getClient().customerPet.findFirst({
      where: { id: petId, customerId, tenantId },
    });
    return row ? this.toRecord(row) : null;
  }

  async create(
    customerId: string,
    id: string,
    data: PetWriteData,
    createdVia: PetCreatedVia,
  ): Promise<PetWriteOutcome> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const gate = await this.lockAndCheckLimit(customerId, tenantId);
      if (gate) return gate;
      const tx = this.tenantPrisma.getClient();
      const row = await tx.customerPet.create({
        data: {
          id,
          tenantId,
          customerId,
          ...data,
          birthDate: toDate(data.birthDate),
          createdVia,
        } as Prisma.CustomerPetUncheckedCreateInput,
      });
      return {
        kind: 'ok',
        pet: this.toRecord(row),
        duplicateName: await this.hasDuplicate(row, tenantId),
      };
    });
  }

  async updateIfVersion(
    customerId: string,
    petId: string,
    expectedVersion: number,
    change: PetChange,
    options: { enforceLimit: boolean; checkDuplicate: boolean },
  ): Promise<PetWriteOutcome> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      if (options.enforceLimit) {
        const gate = await this.lockAndCheckLimit(customerId, tenantId);
        if (gate) return gate;
      }
      const tx = this.tenantPrisma.getClient();
      const { birthDate, ...rest } = change;
      const updated = await tx.customerPet.updateMany({
        where: { id: petId, customerId, tenantId, version: expectedVersion },
        data: {
          ...rest,
          ...(birthDate !== undefined ? { birthDate: toDate(birthDate) } : {}),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) return { kind: 'stale' };
      const row = await tx.customerPet.findFirstOrThrow({
        where: { id: petId, customerId, tenantId },
      });
      return {
        kind: 'ok',
        pet: this.toRecord(row),
        duplicateName: options.checkDuplicate
          ? await this.hasDuplicate(row, tenantId)
          : false,
      };
    });
  }

  /**
   * The pet row is locked (`FOR UPDATE`) so a concurrent edit cannot slip
   * between the version check and the delete. The sale lines are scrubbed
   * BEFORE the delete: once the row is gone the `ON DELETE SET NULL` would
   * have nulled `petId` and the snapshot could no longer be found. Lines,
   * products and amounts are untouched.
   */
  async deleteIfVersion(
    customerId: string,
    petId: string,
    expectedVersion: number,
  ): Promise<PetDeleteOutcome> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const tx = this.tenantPrisma.getClient();
      const locked = await tx.$queryRaw<{ version: number }[]>`
        SELECT "version" FROM customer_pets
        WHERE id = ${petId} AND "customerId" = ${customerId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      if (locked.length === 0) return { kind: 'not_found' };
      if (locked[0].version !== expectedVersion) {
        return { kind: 'version_conflict', currentVersion: locked[0].version };
      }
      await tx.saleItem.updateMany({
        where: { petId, tenantId },
        data: { petId: null, petNameSnapshot: null, petSpeciesSnapshot: null },
      });
      await tx.customerPet.deleteMany({
        where: { id: petId, customerId, tenantId },
      });
      return { kind: 'deleted' };
    });
  }

  /**
   * Locks the customer row (the lock checkout and customer delete take) so two
   * concurrent writers cannot both pass the ACTIVE limit; returns the refusal
   * or `null` when the write may go ahead.
   */
  private async lockAndCheckLimit(
    customerId: string,
    tenantId: string,
  ): Promise<PetWriteOutcome | null> {
    const tx = this.tenantPrisma.getClient();
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id = ${customerId} AND "tenantId" = ${tenantId} FOR UPDATE
    `;
    if (locked.length === 0) return { kind: 'customer_not_found' };
    const active = await tx.customerPet.count({
      where: { customerId, tenantId, status: 'ACTIVE' },
    });
    return active >= MAX_ACTIVE_PETS_PER_CUSTOMER
      ? { kind: 'limit_reached' }
      : null;
  }

  private async hasDuplicate(
    row: CustomerPet,
    tenantId: string,
  ): Promise<boolean> {
    const others = await this.tenantPrisma.getClient().customerPet.count({
      where: {
        tenantId,
        customerId: row.customerId,
        status: 'ACTIVE',
        nameKey: row.nameKey,
        id: { not: row.id },
      },
    });
    return others > 0;
  }

  private toRecord(row: CustomerPet): PetRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      customerId: row.customerId,
      name: row.name,
      nameKey: row.nameKey,
      species: row.species,
      speciesOther: row.speciesOther,
      breed: row.breed,
      size: row.size,
      birthDate: row.birthDate?.toISOString().slice(0, 10) ?? null,
      birthDatePrecision: row.birthDatePrecision,
      allergies: row.allergies,
      notes: row.notes,
      status: row.status,
      archivedAt: row.archivedAt,
      archivedReason: row.archivedReason,
      createdVia: row.createdVia,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
