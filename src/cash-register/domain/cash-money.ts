/**
 * DOMAIN POLICY: cash-register money bounds and safe integer arithmetic (T1/S6).
 *
 * All monetary values are integer cents. Persistence stores them as a
 * PostgreSQL `Int`, so every accepted value MUST fit
 * `[CENTS_STORAGE_MIN, CENTS_STORAGE_MAX]`. Arithmetic that leaves that
 * window is rejected instead of silently wrapping or losing precision.
 */
import { CASH_RULE_CODES, cashRuleViolation } from './cash-register.errors';

export const CENTS_STORAGE_MIN = -2147483647;
export const CENTS_STORAGE_MAX = 2147483647;

/** Reject `NaN`, `Infinity` and fractional cents. */
export function assertIntegerCents(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw cashRuleViolation(
      CASH_RULE_CODES.CENTS_NOT_INTEGER,
      `${field} must be an integer number of cents`,
      { field, value },
    );
  }
}

/** Reject any value outside the persisted Int cents window. */
export function assertStorageRangeCents(value: number, field: string): void {
  assertIntegerCents(value, field);
  if (value < CENTS_STORAGE_MIN || value > CENTS_STORAGE_MAX) {
    throw cashRuleViolation(
      CASH_RULE_CODES.CENTS_OUT_OF_RANGE,
      `${field} must fit the Int cents storage range`,
      { field, value, min: CENTS_STORAGE_MIN, max: CENTS_STORAGE_MAX },
    );
  }
}

/** Counted cash and opening funds can never be negative. */
export function assertNonNegativeCents(value: number, field: string): void {
  assertIntegerCents(value, field);
  if (value < 0) {
    throw cashRuleViolation(
      CASH_RULE_CODES.CENTS_NEGATIVE,
      `${field} must not be negative`,
      { field, value },
    );
  }
}

function assertArithmeticRange(
  value: number,
  field: string,
  details: Record<string, unknown>,
): number {
  if (
    !Number.isInteger(value) ||
    value < CENTS_STORAGE_MIN ||
    value > CENTS_STORAGE_MAX
  ) {
    throw cashRuleViolation(
      CASH_RULE_CODES.ARITHMETIC_OVERFLOW,
      `${field} arithmetic exceeded the safe cents storage range`,
      { field, value, ...details },
    );
  }
  return value;
}

/** Add two in-range amounts; reject if the sum leaves the storage window. */
export function addCents(left: number, right: number, field: string): number {
  assertStorageRangeCents(left, field);
  assertStorageRangeCents(right, field);
  return assertArithmeticRange(left + right, field, { left, right, op: 'add' });
}

/** Subtract two in-range amounts with the same overflow guard. */
export function subtractCents(
  left: number,
  right: number,
  field: string,
): number {
  assertStorageRangeCents(left, field);
  assertStorageRangeCents(right, field);
  return assertArithmeticRange(left - right, field, {
    left,
    right,
    op: 'subtract',
  });
}

/** Sum a list exactly; the running total is overflow-checked at each step. */
export function sumCents(values: readonly number[], field: string): number {
  let total = 0;
  for (const value of values) {
    total = addCents(total, value, field);
  }
  return total;
}

/**
 * Multiply a denomination by its quantity. Products that would not fit the
 * cents window are rejected; accepted products are exact (the result is at
 * most `CENTS_STORAGE_MAX`, hence representable).
 */
export function multiplyCents(
  amountCents: number,
  quantity: number,
  field: string,
): number {
  assertStorageRangeCents(amountCents, field);
  assertStorageRangeCents(quantity, `${field}.quantity`);
  return assertArithmeticRange(amountCents * quantity, field, {
    amountCents,
    quantity,
    op: 'multiply',
  });
}
