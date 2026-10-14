/**
 * SHARED DTO PRIMITIVES: cash-register presentation (T3/S1,S3,S6,S8).
 *
 * Transport-only helpers reused by every cash-register DTO. They deliberately
 * import no domain/Prisma/NestJS runtime code so they stay trivially testable
 * with the real global `ValidationPipe` (`whitelist: true`,
 * `forbidNonWhitelisted: true`, `transform: true` — see `src/main.ts`).
 *
 * Money is integer cents bounded by the persisted PostgreSQL `Int` window
 * (`CENTS_STORAGE_MIN..CENTS_STORAGE_MAX`, mirrored from `cash-money.ts`); the
 * DTO layer only rejects structurally impossible input — sign, ownership and
 * state rules stay in the application/domain.
 */
import { Transform } from 'class-transformer';
import {
  ValidateIf,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

/** Largest value a PostgreSQL `Int` cents column can store. */
export const CASH_CENTS_MAX = 2147483647;

/** Register name bound (UTF-16 code units). */
export const CASH_NAME_MAX_LENGTH = 120;

/** Manual movement reason bound (UTF-16 code units). */
export const CASH_REASON_MAX_LENGTH = 500;

/** Free-text notes bound (UTF-16 code units). */
export const CASH_NOTES_MAX_LENGTH = 2000;

/** Count channel key bound (UTF-16 code units). */
export const CASH_CHANNEL_KEY_MAX_LENGTH = 120;

/** Maximum number of count lines accepted per declaration/verification. */
export const CASH_COUNT_LINES_MAX = 100;

/** Maximum number of denomination lines accepted per count. */
export const CASH_DENOMINATIONS_MAX = 100;

/** 1-based default page for the history/list queries. */
export const CASH_LIST_DEFAULT_PAGE = 1;

/** Default page size for the history/list queries. */
export const CASH_LIST_DEFAULT_LIMIT = 25;

/** Hard page-size cap for the history/list queries. */
export const CASH_LIST_MAX_LIMIT = 100;

/**
 * Technical safe-skip cap: the largest 1-based page whose
 * `(page - 1) * CASH_LIST_MAX_LIMIT` still fits the signed 32-bit `skip`
 * argument the persistence layer passes to PostgreSQL.
 */
export const CASH_LIST_MAX_PAGE =
  Math.floor(CASH_CENTS_MAX / CASH_LIST_MAX_LIMIT) + 1;

/**
 * Strict unsigned-decimal grammar (no `+`, `-`, leading zeros, `1e0`, `0x10`,
 * whitespace or fractions). Non-matching strings are returned unchanged so the
 * following `@IsInt` decorator rejects them instead of a coerced value leaking
 * through.
 */
const STRICT_UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;

/**
 * Result a strict query transform hands to `class-validator`: a parsed value
 * or an invalid marker that always fails the following decorators. Never
 * `unknown`, so the boundary is explicit.
 */
export type ParsedQueryValue = number | boolean | string;

/** Sentinel that fails any `@IsInt` / `@IsBoolean` check. */
export const INVALID_QUERY_VALUE = '\u0000invalid-query-value';

/** Parse a query string strictly; direct numbers pass through untouched. */
export function parseStrictNonNegativeInteger(
  value: unknown,
): ParsedQueryValue {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && STRICT_UNSIGNED_INTEGER.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  return typeof value === 'string' ? value : INVALID_QUERY_VALUE;
}

/** Parse the literal query booleans `true`/`false`; anything else is returned. */
export function parseStrictBoolean(value: unknown): ParsedQueryValue {
  if (value === true || value === false) {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return typeof value === 'string' ? value : INVALID_QUERY_VALUE;
}

/**
 * Skip validation ONLY when the property is omitted (`undefined`). Unlike
 * `@IsOptional`, an explicit `null` is still validated and rejected, so a
 * `null` can never override a default or reach the application layer.
 */
export function IsCashOptional(): PropertyDecorator {
  return ValidateIf((_object, value: unknown) => value !== undefined);
}

/** Trim a string body/query value; non-strings pass through untouched. */
export function TrimString(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

/**
 * True only for an ISO-8601 timestamp that carries an EXPLICIT timezone
 * (`Z`, `±HH:MM`, or `±HHMM`). A local wall-clock string is ambiguous across
 * tenants and is rejected instead of being interpreted in server local time.
 */
export function isTimeZonedIsoTimestamp(value: string): boolean {
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

@ValidatorConstraint({ name: 'timeZonedIsoTimestamp', async: false })
export class TimeZonedIsoTimestampConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value !== 'string' || isTimeZonedIsoTimestamp(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be an ISO-8601 timestamp with an explicit timezone`;
  }
}

/** Validate that a string carries an explicit timezone. */
export const IsTimeZonedIsoTimestamp = (): PropertyDecorator =>
  Validate(TimeZonedIsoTimestampConstraint);
