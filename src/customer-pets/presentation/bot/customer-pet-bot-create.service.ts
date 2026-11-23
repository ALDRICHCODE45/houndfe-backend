/**
 * Idempotent pet create of the bot (contract §7). The receipt lives in
 * `chatbot_bot_receipts` (kind `CUSTOMER_PET_CREATE`, key `(tenantId, kind,
 * idempotencyKey)`) and is written in the SAME transaction as the pet: the
 * outer `runInTransaction` is the ambient one, so the repository's own
 * transaction joins it and the pet and the receipt commit or roll back together
 * (a rejected create leaves neither).
 *
 * Same codes as the backorders, so the bot keeps one handler:
 *   same key + same body      → the first response again (`replayed`, 200)
 *   same key + different body → `IDEMPOTENCY_KEY_CONFLICT` (409)
 *   key held by another tx    → `IDEMPOTENCY_KEY_IN_FLIGHT` (409)
 *
 * The existing receipt helpers (`BotIntakeStore`) are bound to the chatbot
 * request intake and its `CREATE|CANCEL|RESCHEDULE` kinds, so this reads and
 * writes the table directly, like `BackordersBotService` does for its own key.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import { CustomerPetsService } from '../../application/customer-pets.service';
import type {
  PetCreateInput,
  PetWriteResult,
} from '../../domain/customer-pet.types';
import { petHttpError } from '../customer-pet-http-error';

export const CUSTOMER_PET_CREATE_RECEIPT_KIND = 'CUSTOMER_PET_CREATE';

export interface BotPetCreateResult {
  /** True when the key was already used by an identical request. */
  replayed: boolean;
  pet: PetWriteResult;
}

/** Namespaced text the advisory lock hashes (exported so a test can hold it). */
export function petCreateLockKey(tenantId: string, key: string): string {
  return JSON.stringify(['bot_customer_pet_create_key', tenantId, key]);
}

/** `null` and absent hash the same, so a retry that spells absence differently replays. */
export function computePetCreateHash(
  customerId: string,
  input: PetCreateInput,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        customerId,
        name: input.name,
        species: input.species,
        speciesOther: input.speciesOther ?? null,
        breed: input.breed ?? null,
        size: input.size ?? null,
        birthDate: input.birthDate ?? null,
        birthDatePrecision: input.birthDatePrecision ?? null,
        approxAge: input.approxAge
          ? {
              years: input.approxAge.years ?? null,
              months: input.approxAge.months ?? null,
            }
          : null,
        allergies: input.allergies ?? null,
        notes: input.notes ?? null,
      }),
    )
    .digest('hex');
}

@Injectable()
export class CustomerPetBotCreateService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly pets: CustomerPetsService,
  ) {}

  async create(
    customerId: string,
    input: PetCreateInput,
    key: string,
  ): Promise<BotPetCreateResult> {
    const tenantId = this.tenantPrisma.getTenantId();
    const commandHash = computePetCreateHash(customerId, input);
    return this.tenantPrisma.runInTransaction(async () => {
      const tx = this.tenantPrisma.getClient();
      const lock = petCreateLockKey(tenantId, key);
      const acquired = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${lock}, 0)) AS acquired
      `;
      if (!acquired[0]?.acquired) {
        throw petHttpError(409, 'IDEMPOTENCY_KEY_IN_FLIGHT');
      }
      const receipt = await tx.chatbotBotReceipt.findFirst({
        where: {
          tenantId,
          kind: CUSTOMER_PET_CREATE_RECEIPT_KIND,
          idempotencyKey: key,
        },
        select: { commandHash: true, responseSnapshot: true },
      });
      if (receipt) {
        if (receipt.commandHash !== commandHash) {
          throw petHttpError(409, 'IDEMPOTENCY_KEY_CONFLICT');
        }
        return {
          replayed: true,
          // SAFETY: written below from a `PetWriteResult` (strings, numbers, null).
          pet: receipt.responseSnapshot as unknown as PetWriteResult,
        };
      }
      const pet = await this.pets.create(customerId, input, 'CHATBOT');
      await tx.chatbotBotReceipt.create({
        data: {
          tenantId,
          kind: CUSTOMER_PET_CREATE_RECEIPT_KIND,
          idempotencyKey: key,
          commandHash,
          responseSnapshot: pet as unknown as Prisma.InputJsonObject,
        },
      });
      return { replayed: false, pet };
    });
  }
}
