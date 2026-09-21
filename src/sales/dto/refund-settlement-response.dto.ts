import { isUUID } from 'class-validator';
import type { SaleRefundMethod } from '../domain/sale.repository';
import { MAX_CENTS, SALE_REFUND_METHODS } from './settle-refund.dto';

/**
 * rfs-3a — replayable response contract for one persisted refund settlement.
 * Declared explicitly (not a re-export of the domain `RefundSettlementResult`)
 * so the shape cannot widen silently with the domain write result. `settledAt`
 * is the canonical UTC ISO-8601 string, never a `Date`.
 */
export interface RefundSettlementResponseDto {
  settlementId: string;
  refundId: string;
  saleId: string;
  amountCents: number;
  method: SaleRefundMethod;
  reference: string | null;
  settledAt: string;
  settledCents: number;
  outstandingCents: number;
}

/** IDs are UUIDs, so a replay can never smuggle an arbitrary ID string. */
const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && isUUID(value);

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

/** Installment amounts mirror the request bounds: 1..Int ceiling. */
const isInstallmentAmount = (value: unknown): value is number =>
  isInteger(value) && value >= 1 && value <= MAX_CENTS;

/** Cumulative and outstanding balances are Int-bounded, non-negative cents. */
const isBalanceCents = (value: unknown): value is number =>
  isInteger(value) && value >= 0 && value <= MAX_CENTS;

const isSaleRefundMethod = (value: unknown): value is SaleRefundMethod =>
  SALE_REFUND_METHODS.some((method) => method === value);

/** Accepts only the canonical `Date.prototype.toISOString()` rendering. */
const isCanonicalIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0) return false;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;

  return parsed.toISOString() === value;
};

/**
 * rfs-3a — narrow runtime guard for replayed `unknown` JSON: it rejects
 * malformed IDs/types, unsupported methods, out-of-range amounts/balances,
 * non-null/non-string references, non-canonical timestamps, inconsistent
 * balances (`settledCents < amountCents` or `settledCents + outstandingCents >
 * MAX_CENTS`), and missing keys (an absent key reads as `undefined`).
 */
export function isRefundSettlementResponseDto(
  value: unknown,
): value is RefundSettlementResponseDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const { amountCents, settledCents, outstandingCents } = record;

  return (
    isUuid(record.settlementId) &&
    isUuid(record.refundId) &&
    isUuid(record.saleId) &&
    isInstallmentAmount(amountCents) &&
    isSaleRefundMethod(record.method) &&
    (record.reference === null || typeof record.reference === 'string') &&
    isCanonicalIsoTimestamp(record.settledAt) &&
    isBalanceCents(settledCents) &&
    isBalanceCents(outstandingCents) &&
    settledCents >= amountCents &&
    settledCents + outstandingCents <= MAX_CENTS
  );
}
