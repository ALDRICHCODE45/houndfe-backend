/**
 * cash-register-closing / S10 — adapter value primitives (S1–S8).
 *
 * Pure, dependency-light helpers shared by the storage, command, query and
 * ledger modules: JSON/document coercion at the port boundary, deterministic
 * request canonicalization and payment-method mapping. No Prisma/Nest
 * instance state is touched here.
 */
import { type Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import type {
  CashCommand,
  CashDocument,
  CashJson,
} from '../cash-application.port';
import type { CashPaymentMethod } from '../cash-ledger.port';
import type { CashCountLine, CashMethod } from '../domain';

/** Opaque, tenant-unique folio; no guessable date counter. */
export function newFolio(): string {
  return `CC-${randomUUID()}`;
}

export function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && (error as { code?: unknown }).code === 'P2002';
}

export function document(value: Record<string, unknown>): CashDocument {
  return documentValue(value);
}

/**
 * SAFETY: every cash document/JSON payload is assembled exclusively from
 * JSON-safe primitives (strings, finite integers, null, nested plain
 * objects/arrays). The port's structural index signature cannot be inferred
 * from the domain/projection interfaces, so the boundary cast is deliberate
 * and confined to these helpers.
 */
export function json(value: unknown): CashJson {
  // SAFETY: the value is JSON-safe by the invariant documented above.
  return value as CashJson;
}

export function prismaJson(value: unknown): Prisma.InputJsonValue {
  // SAFETY: a JSON-safe payload is a valid Prisma JSON input by construction.
  return value as Prisma.InputJsonValue;
}

export function documentValue(value: unknown): CashDocument {
  // SAFETY: the value is a JSON-safe object by the documented invariant.
  return value as CashDocument;
}

export function asCashMethod(value: string): CashMethod {
  switch (value) {
    case 'CASH':
      return 'CASH';
    case 'CARD_CREDIT':
      return 'CARD_CREDIT';
    case 'CARD_DEBIT':
      return 'CARD_DEBIT';
    case 'TRANSFER':
      return 'TRANSFER';
    default:
      throw cashAppError(
        CASH_APPLICATION_CODES.LEDGER_METHOD_INVALID,
        `Unsupported cash movement method ${value}`,
        { method: value },
      );
  }
}

export function ledgerMethodToCashMethod(
  method: CashPaymentMethod,
): CashMethod {
  switch (method) {
    case 'cash':
      return 'CASH';
    case 'card_credit':
      return 'CARD_CREDIT';
    case 'card_debit':
      return 'CARD_DEBIT';
    case 'transfer':
      return 'TRANSFER';
    default:
      throw cashAppError(
        CASH_APPLICATION_CODES.LEDGER_METHOD_INVALID,
        `Unsupported ledger payment method ${String(method)}`,
        { method: String(method) },
      );
  }
}

/** Stable, key-sorted canonicalization for the idempotency request hash. */
export function canonicalize(value: unknown): CashJson {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    const out: Record<string, CashJson> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) {
        continue;
      }
      out[key] = canonicalize(entry);
    }
    return out;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  // undefined / non-finite numbers never participate in a cash command.
  return null;
}

/** The shared DECLARE/VERIFY member carries a `kind` union, so `Extract` on
 * the discriminant would yield `never`; match on the shared fields instead. */
export type CountCommand = Extract<
  CashCommand,
  { sessionId: string; lines: CashCountLine[] }
>;
