/**
 * DOMAIN GUARDS: cash-register identity + date validation (T1/S8).
 *
 * Public domain boundaries accept identifiers and dates from application
 * adapters. Blank identities and invalid dates must fail closed before any
 * state or money rule is evaluated, so `new Date('nope')` can never slip into
 * a decision.
 */
import { CASH_RULE_CODES, cashRuleViolation } from './cash-register.errors';

export function isNonEmptyText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Require a non-blank identifier/text; returns the trimmed value. */
export function assertNonEmptyText(
  value: string | null | undefined,
  field: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw cashRuleViolation(
      CASH_RULE_CODES.IDENTITY_REQUIRED,
      `${field} must be a non-empty identifier`,
      { field },
    );
  }
  return value.trim();
}

/** Require a real, finite `Date` instance. */
export function assertValidDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw cashRuleViolation(
      CASH_RULE_CODES.DATE_INVALID,
      `${field} must be a valid date`,
      { field },
    );
  }
  return value;
}

/** Require a real date when present; `null` passes through untouched. */
export function assertOptionalValidDate(
  value: Date | null,
  field: string,
): Date | null {
  if (value === null) {
    return null;
  }
  return assertValidDate(value, field);
}
