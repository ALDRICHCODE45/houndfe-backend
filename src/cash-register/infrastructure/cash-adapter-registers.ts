/**
 * cash-register-closing / S10 — register commands (S1, S3).
 *
 * Creating and updating named registers within the tenant boundary. The
 * caller's capability is rechecked against a server-owned instance; body
 * fields never influence the authorization decision.
 */
import { Prisma } from '@prisma/client';
import { assertNonEmptyText } from '../domain';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import type {
  CashActor,
  CashCommand,
  CashDocument,
} from '../cash-application.port';
import type { TenantClient } from './cash-adapter-client';
import { registerDocument } from './cash-adapter-mappers';
import {
  assertCommandAbility,
  registerInstance,
} from './cash-adapter-instances';
import { lockRegisterRow } from './cash-adapter-storage';
import { isUniqueViolation } from './cash-adapter-values';

export async function createRegister(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  name: string,
): Promise<CashDocument> {
  // Prospective server-owned context: the caller cannot inject body actor
  // or expected fields into the authorization decision.
  assertCommandAbility(actor, 'CREATE_REGISTER', {
    tenantId,
    ownerUserId: actor.userId,
  });
  const trimmed = assertNonEmptyText(name, 'name');
  const existing = await tx.cashRegister.findFirst({
    where: { tenantId, name: trimmed },
  });
  if (existing) {
    throw cashAppError(
      CASH_APPLICATION_CODES.REGISTER_NAME_CONFLICT,
      'A cash register with that name already exists in this tenant',
      { name: trimmed },
    );
  }
  try {
    const row = await tx.cashRegister.create({
      data: { tenantId, name: trimmed, isActive: true },
    });
    return registerDocument(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw cashAppError(
        CASH_APPLICATION_CODES.REGISTER_NAME_CONFLICT,
        'A cash register with that name already exists in this tenant',
        { name: trimmed },
      );
    }
    throw error;
  }
}

export async function updateRegister(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  command: Extract<CashCommand, { kind: 'UPDATE_REGISTER' }>,
): Promise<CashDocument> {
  const locked = await lockRegisterRow(tx, tenantId, command.id);
  if (!locked) {
    throw cashAppError(
      CASH_APPLICATION_CODES.REGISTER_NOT_FOUND,
      'Cash register not found',
      { registerId: command.id },
    );
  }
  const row = await tx.cashRegister.findFirst({
    where: { tenantId, id: command.id },
  });
  if (!row) {
    throw cashAppError(
      CASH_APPLICATION_CODES.REGISTER_NOT_FOUND,
      'Cash register not found',
      { registerId: command.id },
    );
  }
  assertCommandAbility(actor, 'UPDATE_REGISTER', registerInstance(row));
  const data: Prisma.CashRegisterUpdateInput = {};
  if (command.name !== undefined) {
    const name = assertNonEmptyText(command.name, 'name');
    if (name !== row.name) {
      const clash = await tx.cashRegister.findFirst({
        where: { tenantId, name },
      });
      if (clash) {
        throw cashAppError(
          CASH_APPLICATION_CODES.REGISTER_NAME_CONFLICT,
          'A cash register with that name already exists in this tenant',
          { name },
        );
      }
    }
    data.name = name;
  }
  if (command.isActive !== undefined) {
    if (typeof command.isActive !== 'boolean') {
      throw cashAppError(
        CASH_APPLICATION_CODES.PERMISSION_DENIED,
        'isActive must be a boolean',
      );
    }
    data.isActive = command.isActive;
  }
  const updated = await tx.cashRegister.update({
    where: { id: row.id },
    data,
  });
  return registerDocument(updated);
}
